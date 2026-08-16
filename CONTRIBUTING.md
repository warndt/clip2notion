# Contributing

In summary: **suggestions yes, pull requests no, forks yes.**

## The project does not accept pull requests

This is not a statement about the value of contributions. It is a result of what this repository is. It is a personal tool that operates one person's workflow. It is public because the method can be useful to other persons. It has one user, one installation, and a set of limits in [CLAUDE.md](CLAUDE.md). Most of those limits exist because something failed in production with no visible sign, and a person used many hours to find the cause.

I cannot test a change against that workflow. Therefore I must either keep the change and not merge it, or merge it with no test. To say no clearly at the start is better than both of these.

If you send a pull request, I will close it and give a link to this file. This is not a statement about the quality of your code.

## What the project accepts

**Write an issue.** This is useful, and it is the most probable method to change the code.

- **A website that clips incorrectly.** This is the most valuable report. Give the URL and describe the problem: a section that is not present, a table that is not correct, or an image that arrived as a 1×1 spacer. Almost each correction in the backlog of `ROADMAP.md` started with one real article that caused a failure, and each one became a test.
- **A bug, with the steps to cause it.** Give the call that you made, the result, and the result that you expected.
- **A security problem.** Do not write a public issue. Refer to [SECURITY.md](SECURITY.md).
- **A question about how to change the service for your use.** If the README does not answer your question, that is a defect in the README. Report it as one.

**Make a fork.** This is the recommended method. The licence is MIT, so you do not need permission. If your installation is different from mine (a different platform, a different database, or no Claude), a fork operates better than a configuration option that I must maintain and cannot test. The [Adapting it](README.md#how-to-change-the-service-for-your-use) section of the README is for this purpose.

If you build something interesting with this code, I would like to know. Write an issue.

## If you read the code

Two facts will save you time.

1. **Read [CLAUDE.md](CLAUDE.md) first.** It lists the limits that cause a failure in production and not in a test: the 10-second limit for a synchronous function, the rule that keeps jsdom out of the light half of `src/`, the Notion limit of 2,000 characters for each rich-text object, and the rule that a background function must almost never throw an error. Some of these look unnecessary until you know what they prevent.
2. **The Backlog in `ROADMAP.md` is a list of failures and not a list of ideas.** Each entry gives what failed, the cause, and frequently a correction that looks correct but is not. If you are going to change something and there is an entry about it, read the entry first.

The tests cover the failures that the service cannot see: content that the service writes two times, text that a limit removes, an image that becomes an external link, and a status function that reports a clip that did not occur. Keep those tests correct.
