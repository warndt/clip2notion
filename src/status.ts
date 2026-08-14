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
import { ERROR_MARKER, HEADER_PREFIX, STATUS_MARKER } from "./markers";
import {
  blockFirstLink, blockLinksTo, blockPlainText, NotionClient, type NotionBlockRecord,
} from "./notion";

// --- Status ----------------------------------------------------------------

export type ClipState = "not_started" | "in_progress" | "clipped" | "failed";

export interface ClipStatus {
  state: ClipState;
  detail?: string;
  sourceUrl?: string;
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
  const failure = children.find(
    (block) => block.type === "callout" && blockPlainText(block).includes(ERROR_MARKER),
  );
  if (failure) {
    return { state: "failed", detail: blockPlainText(failure) };
  }

  const running = children.find(
    (block) => block.type === "callout" && blockPlainText(block).includes(STATUS_MARKER),
  );
  if (running) {
    return { state: "in_progress", detail: blockPlainText(running) };
  }

  const header = children.find(
    (block) =>
      block.type === "paragraph" &&
      blockPlainText(block).startsWith(HEADER_PREFIX) &&
      blockFirstLink(block) !== null,
  );
  if (header) {
    return {
      state: "clipped",
      detail: blockPlainText(header),
      sourceUrl: blockFirstLink(header) ?? undefined,
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
   */
  const substantive = children.filter(
    (block) => block.type !== "divider" && blockPlainText(block).trim().length > 0,
  );
  if (substantive.length >= TUNABLES.orphanContentThreshold) {
    return {
      state: "in_progress",
      detail: `Page holds ${substantive.length} blocks but no clip header — a clip is probably mid-write.`,
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
      if (status.state !== "in_progress") return status;
    }

    await new Promise((resolve) => setTimeout(resolve, TUNABLES.statusPollIntervalMs));
  }

  return started ? { state: "in_progress" } : null;
}
