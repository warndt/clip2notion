/**
 * Reading and waiting on a clip's state.
 *
 * Separate from `pipeline.ts` on purpose: this is everything `mcp.ts` needs to
 * answer "did it work?", and it imports no HTML machinery. `pipeline.ts` pulls
 * in the converter and Readability, which drag jsdom behind them and cost
 * seconds of cold start — enough to push a synchronous function past Netlify's
 * 10s kill. Keep this module free of those imports.
 */

import { TUNABLES, type Config } from "./config";
import { ERROR_MARKER, HEADER_PREFIX, PARTIAL_WRITE_MARKER, STATUS_MARKER } from "./markers";
import {
  blockFirstLink, blockLinksTo, blockPlainText, NotionClient, type NotionBlockRecord,
} from "./notion";

// --- Status ----------------------------------------------------------------

/**
 * `foreign_content` is the honest answer to a page holding content none of
 * which is ours: a Web Clipper save, pasted notes, a half-deleted clip. The
 * service cannot tell which, and both of the confident answers are wrong in a
 * costly direction — `not_started` invites a non-force clip that appends a
 * second copy, `in_progress` tells the caller to poll something that will never
 * move. Saying "there is content here and none of it is mine" is the only claim
 * the block list actually supports.
 */
export type ClipState = "not_started" | "in_progress" | "clipped" | "failed" | "foreign_content";

export interface ClipStatus {
  state: ClipState;
  detail?: string;
  sourceUrl?: string;
  /**
   * When the block that decided this state was created — the clip header for
   * `clipped`, the progress callout for `in_progress`.
   *
   * `CLIPPED` alone is unfalsifiable on a page that already held a clip: it
   * cannot tell a completed re-run from stale content sitting untouched, which
   * is exactly what left three forced re-clips unverifiable from the caller's
   * side. A forced re-clip deletes the old header and writes a new one, so this
   * moves when a run really happened and doesn't when it didn't.
   *
   * Notion reports block creation to the minute, so two runs inside the same
   * minute are indistinguishable here. Nothing else in the system is affected —
   * this is a report, never a decision input.
   */
  markerCreatedAt?: string;
  /**
   * Which run wrote the marker that decided this state.
   *
   * Both callouts embed their `clip_id`, so the page already records whose
   * verdict it is carrying — nothing read it back, so nothing could tell a
   * fresh failure from one left lying there by an earlier run. `awaitOwnRun`
   * needs exactly that distinction: it guards which run *started*, and without
   * this it would still hand back a verdict belonging to someone else.
   */
  markerClipId?: string;
  /**
   * An error callout from an earlier run that a later clip has superseded.
   *
   * Set only alongside `clipped`. The callout is left on the page — deleting
   * content on the service's own initiative is the thing `force` exists to
   * confine — so the caller is told it is there and that it describes a
   * different run.
   */
  staleError?: string;
}

/** Both callouts carry `(clp_xxxxxxxx)`; this reads it back out. */
function clipIdIn(text: string): string | undefined {
  return /\bclp_[0-9a-z]+\b/.exec(text)?.[0];
}

/**
 * The most recently created block matching `predicate`.
 *
 * `find` returns the first, which is the wrong end of the page: our writes are
 * appends, so a leftover callout from an earlier run sits *above* the one this
 * run just wrote. Picking the first would report an old verdict in preference
 * to the current one. Ties fall to document order, where later still wins.
 */
function newestMatch(
  blocks: NotionBlockRecord[],
  predicate: (block: NotionBlockRecord) => boolean,
): NotionBlockRecord | undefined {
  let best: NotionBlockRecord | undefined;
  let bestAt: string | undefined;
  for (const block of blocks) {
    if (!predicate(block)) continue;
    const at = createdTime(block);
    if (best === undefined || bestAt === undefined || (at !== undefined && at >= bestAt)) {
      best = block;
      bestAt = at;
    }
  }
  return best;
}

/** Notion stamps `created_time` on every block; absent or odd values just don't report. */
function createdTime(block: NotionBlockRecord): string | undefined {
  const raw = block["created_time"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** The most recent `created_time` in a set of blocks, if any of them carry one. */
function newestCreatedTime(blocks: NotionBlockRecord[]): string | undefined {
  let newest: string | undefined;
  for (const block of blocks) {
    const at = createdTime(block);
    if (at && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
}

/**
 * "2026-08-15 00:31 UTC (2 minutes ago)" — absolute so it can be checked
 * against a Notion page, relative because the question being asked is almost
 * always "did that just happen, or is this yesterday's clip?"
 */
export function describeClipTime(iso: string | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;

  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;

  const stamp = `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
  const seconds = Math.round((now - at.getTime()) / 1000);

  // A clock skew of a few seconds is normal; don't render "in 3 seconds".
  if (seconds < 45) return `${stamp} (moments ago)`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${stamp} (${minutes} minute${minutes === 1 ? "" : "s"} ago)`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${stamp} (${hours} hour${hours === 1 ? "" : "s"} ago)`;

  return `${stamp} (${Math.round(hours / 24)} days ago)`;
}

/**
 * Work out what state a page is in from its blocks.
 *
 * This exists because a caller cannot tell whether a clip worked from the
 * dispatch response — the work outlives the request. Reading the page gives a
 * definite answer instead of one inferred from wording.
 *
 * Order matters. A run that failed partway leaves *both* partial content and an
 * error callout, and that is a failure, not a success with extra decoration.
 */
export function deriveClipStatus(children: NotionBlockRecord[]): ClipStatus {
  // Named `failure` rather than `errorCallout` — that name is already the
  // imported block builder, and shadowing it here would be a trap.
  const failure = newestMatch(
    children,
    (block) => block.type === "callout" && blockPlainText(block).includes(ERROR_MARKER),
  );

  const header = children.find(
    (block) =>
      block.type === "paragraph" &&
      blockPlainText(block).startsWith(HEADER_PREFIX) &&
      blockFirstLink(block) !== null,
  );

  /**
   * An error callout outranks everything — unless it cannot be describing the
   * article that is sitting under it.
   *
   * The rank exists because a run that dies partway leaves both partial content
   * and an error, and that is a failure, not a success with decoration. What the
   * rank could not survive was an error from a *different*, earlier run: only
   * `force` sweeps callouts, so a failed clip followed by an ordinary clip of
   * another URL left both on the page, and the page then reported FAILED for
   * good, quoting the wrong site, while holding a complete article.
   *
   * Ownership decides it, and the failing run already recorded its own: an error
   * whose message lacks `PARTIAL_WRITE_MARKER` comes from a run that wrote no
   * content at all. Such a run cannot be the author of an article on the page,
   * so its error cannot be about that article.
   *
   * Timestamps alone could not carry this. Notion records creation to the
   * minute, and a 403 fails in about a second, so a failure and the retry that
   * follows it routinely share one minute — measured live on 2026-08-16, where
   * two runs seven seconds apart both stamped 23:44 and the tie sent a complete
   * clip back as FAILED. The clock is kept only as a floor: a header *older*
   * than the error belongs to some earlier clip and must not be reported as the
   * outcome of the run that just failed. Both stamps must be present; when they
   * are not, nothing can be ordered and the safe reading is failure.
   */
  const failedAt = failure ? createdTime(failure) : undefined;
  const headerAt = header ? createdTime(header) : undefined;
  const wroteNothing = failure
    ? !blockPlainText(failure).includes(PARTIAL_WRITE_MARKER)
    : false;
  const superseded = Boolean(wroteNothing && failedAt && headerAt && headerAt >= failedAt);

  if (failure && !superseded) {
    return {
      state: "failed",
      detail: blockPlainText(failure),
      markerCreatedAt: failedAt,
      markerClipId: clipIdIn(blockPlainText(failure)),
    };
  }

  const running = newestMatch(
    children,
    (block) => block.type === "callout" && blockPlainText(block).includes(STATUS_MARKER),
  );
  if (running) {
    return {
      state: "in_progress",
      detail: blockPlainText(running),
      markerCreatedAt: createdTime(running),
      markerClipId: clipIdIn(blockPlainText(running)),
    };
  }

  if (header) {
    return {
      state: "clipped",
      detail: blockPlainText(header),
      sourceUrl: blockFirstLink(header) ?? undefined,
      markerCreatedAt: headerAt,
      staleError: superseded && failure ? blockPlainText(failure) : undefined,
    };
  }

  /**
   * No marker of any kind. Saying "nothing was clipped" about a page that holds
   * a partially written article is the most dangerous thing this function can
   * do: the caller is told a NOT_STARTED page needs a fresh clip *without*
   * `force`, which appends a second copy onto a page that already has one.
   *
   * But "has content" is not evidence of a clip. Resources templates seed body
   * content of their own — a version toggle and a divider — so every freshly
   * created page arrives non-empty. Treating that as a clip in flight would
   * have the caller poll a page where nothing is running.
   *
   * The threshold separates the two: template furniture is a block or two, a
   * half-deleted article is many. And since a forced re-clip now writes its
   * progress callout before deleting anything, that case is marked anyway —
   * this is the second line of defence, not the only one.
   *
   * What it reports is `foreign_content` rather than a guess at which of those
   * it is. It once returned `in_progress`, which was wrong for the commonest
   * cause by far: a Web Clipper save, made on our own advice after a BLOCKED
   * failure, poisoning the status of every page that took the fallback.
   */
  const substantive = children.filter(
    (block) => block.type !== "divider" && blockPlainText(block).trim().length > 0,
  );
  if (substantive.length >= TUNABLES.orphanContentThreshold) {
    return {
      state: "foreign_content",
      detail: `Page holds ${substantive.length} blocks, none of them written by this service.`,
      /**
       * The newest block, standing in for the marker this branch does not have.
       *
       * Without it the caller loses the fifteen-minute bound and cannot ever
       * declare the run dead: a Web Clipper page reported `IN_PROGRESS` to ten
       * consecutive calls with no time attached, and there was no answer that
       * would have let the caller stop. Newest rather than oldest because the
       * question is "did anything land here recently", not "when did this page
       * begin" — a live run has a block seconds old, a finished save does not.
       */
      markerCreatedAt: newestCreatedTime(substantive),
    };
  }

  return { state: "not_started" };
}

export async function getClipStatus(
  pageId: string,
  config: Config,
  clipId: string,
): Promise<ClipStatus> {
  const client = new NotionClient(config, clipId);
  await client.assertPageInDataSource(pageId);
  return deriveClipStatus(await client.listChildren(pageId));
}

/**
 * Poll until the clip settles, or the budget runs out.
 *
 * A tool call cannot sleep on the caller's side, and asking a person to say
 * "check again" is not a workflow — it turns a background job into homework.
 * Blocking here for a bounded window means a typical clip finishes inside a
 * single tool call and the caller never has to ask for anything.
 *
 * The budget is deliberately short of any plausible client timeout. If the work
 * outlives it, the caller is told to call again — which it can do by itself,
 * without involving the user.
 */
/**
 * A deadline that respects both the caller's budget and the platform's ceiling.
 *
 * A synchronous Netlify function is killed at 10 seconds, and a killed function
 * looks to the caller like the whole service is down. `enteredAt` is when the
 * request arrived, so time already spent on Notion round trips counts against
 * the budget rather than being ignored.
 */
/**
 * When this module was first loaded. A handler entering shortly after means the
 * container had to initialise for this request, and that initialisation counts
 * against Netlify's 10s clock even though no code here can observe it.
 */
const MODULE_LOADED_AT = Date.now();

function deadlineFrom(enteredAt: number, budgetMs: number): number {
  const coldStart = enteredAt - MODULE_LOADED_AT < TUNABLES.coldStartWindowMs;
  const ceiling = coldStart ? TUNABLES.coldStartBudgetMs : TUNABLES.syncFunctionBudgetMs;
  return Math.min(Date.now() + budgetMs, enteredAt + ceiling);
}

export async function awaitClipSettled(
  pageId: string,
  config: Config,
  clipId: string,
  budgetMs: number = TUNABLES.statusWaitBudgetMs,
  enteredAt: number = Date.now(),
): Promise<ClipStatus> {
  const client = new NotionClient(config, clipId);
  await client.assertPageInDataSource(pageId);

  const deadline = deadlineFrom(enteredAt, budgetMs);
  let status = deriveClipStatus(await client.listChildren(pageId));

  while (status.state === "in_progress" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TUNABLES.statusPollIntervalMs));
    status = deriveClipStatus(await client.listChildren(pageId));
  }

  return status;
}

/**
 * Wait for the run identified by `clipId` — not for whatever happens to be on
 * the page right now.
 *
 * `clip_article` dispatches and then watches, so on the first look the previous
 * clip may still be sitting there untouched. Reporting that is how a re-clip
 * came back "CLIPPED — this is a confirmed result" seconds after being asked to
 * replace the very clip it was describing.
 *
 * So this waits for *our* progress marker to appear before it will believe any
 * terminal state. If the marker never shows up in time, the honest answer is
 * "started, outcome unknown" rather than a borrowed verdict.
 */
export async function awaitOwnRun(
  pageId: string,
  config: Config,
  clipId: string,
  budgetMs: number,
  enteredAt: number = Date.now(),
): Promise<ClipStatus | null> {
  // No parent check here: `clip_article` has already made it, and repeating it
  // spends a Notion round trip out of a budget measured against a 10s kill.
  const client = new NotionClient(config, clipId);

  const deadline = deadlineFrom(enteredAt, budgetMs);
  const startDeadline = Math.min(deadline, Date.now() + TUNABLES.runStartWaitMs);
  let started = false;

  while (Date.now() < deadline) {
    const children = await client.listChildren(pageId);

    if (!started) {
      started = children.some(
        (block) => block.type === "callout" && blockPlainText(block).includes(clipId),
      );
      // The marker is written before any other work, so if it has not appeared
      // by now this run is not the one shaping the page.
      if (!started && Date.now() > startDeadline) return null;
    }

    if (started) {
      const status = deriveClipStatus(children);
      // A failure some other run wrote is not our outcome. Our own marker being
      // present says this run started, not that this error belongs to it — and
      // an error callout an earlier run left behind sits on the page until
      // someone removes it. Keep waiting for a verdict that is actually ours.
      const borrowedFailure =
        status.state === "failed" &&
        status.markerClipId !== undefined &&
        status.markerClipId !== clipId;

      if (status.state !== "in_progress" && !borrowedFailure) return status;
    }

    await new Promise((resolve) => setTimeout(resolve, TUNABLES.statusPollIntervalMs));
  }

  return started ? { state: "in_progress" } : null;
}
