import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNRELEASED,
  groupCommits,
  issueNumbers,
  linkIssues,
  parseCommit,
  parseCommits,
  renderChangelog,
} from "../../scripts/generate-changelog.mjs";

const REPO = "https://github.com/Stellar-Agent-Guard/stellar-agent-guard-dashboard";

/**
 * One record of the `git log --format=…` stream `parseCommits` consumes: the hash,
 * the subject and the body, joined by the same separators the script asks git for.
 * Written out literally on purpose — this is the script's input contract, and a
 * silent change to it should fail here.
 */
const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";
const logRecord = (hash: string, subject: string, body = ""): string =>
  `${hash}${FIELD_SEPARATOR}${subject}${FIELD_SEPARATOR}${body}${RECORD_SEPARATOR}`;

/**
 * Parse a subject the test expects to be conventional.
 *
 * This throws rather than only asserting, so the parsed commit comes back
 * narrowed — a narrowing the test owns instead of one borrowed from the assertion
 * library's signature.
 */
function mustParse(subject: string, body = "") {
  const parsed = parseCommit(subject, body);
  if (parsed === null) {
    throw new Error(`expected a conventional commit subject, got: "${subject}"`);
  }
  return parsed;
}

describe("parseCommit", () => {
  it("reads the type, scope and description of a conventional subject", () => {
    const parsed = mustParse("feat(guard): add rotateAgentKey operation function");
    assert.equal(parsed.type, "feat");
    assert.equal(parsed.scope, "guard");
    assert.equal(parsed.description, "add rotateAgentKey operation function");
    assert.equal(parsed.breaking, false);
  });

  it("accepts a subject with no scope", () => {
    const parsed = mustParse("chore: lock the dependency tree");
    assert.equal(parsed.type, "chore");
    assert.equal(parsed.scope, null);
  });

  it("treats a `!` marker as a breaking change", () => {
    const parsed = mustParse("feat(api)!: rename the policy encoder");
    assert.equal(parsed.breaking, true);
    assert.equal(parsed.description, "rename the policy encoder");
  });

  it("treats a BREAKING CHANGE footer as a breaking change", () => {
    const parsed = mustParse(
      "fix(policy): reject a zero window cap",
      "BREAKING CHANGE: cap is now required",
    );
    assert.equal(parsed.breaking, true);
  });

  it("lower-cases the type so FEAT and feat land in the same section", () => {
    const parsed = mustParse("Feat(UI): add a console page");
    assert.equal(parsed.type, "feat");
    assert.equal(parsed.scope, "UI");
  });

  it("collects the issue numbers a description references", () => {
    const parsed = mustParse("fix(scval): support Node webcrypto fallback (#121, #122)");
    assert.deepEqual(parsed.issues, ["121", "122"]);
  });

  it("rejects anything that does not declare a type", () => {
    assert.equal(parseCommit("initial commit"), null);
    assert.equal(parseCommit("Merge pull request #7 from a/b"), null);
    assert.equal(parseCommit("fixup! feat(guard): add rotateAgentKey"), null);
    assert.equal(parseCommit(""), null);
  });
});

describe("issueNumbers", () => {
  it("finds references written as (#12), #12 and trailing #12", () => {
    assert.deepEqual(issueNumbers("closes #120"), ["120"]);
    assert.deepEqual(issueNumbers("add husky (#120)"), ["120"]);
    assert.deepEqual(issueNumbers("(#1) and #2"), ["1", "2"]);
  });

  it("de-duplicates and keeps the order it found them in", () => {
    assert.deepEqual(issueNumbers("#12 #9 #12"), ["12", "9"]);
  });

  it("does not mistake a URL fragment or a hash-less number for an issue", () => {
    assert.deepEqual(issueNumbers("https://example.com/page#42"), []);
    assert.deepEqual(issueNumbers("sha1 f47919f92e78fdd0"), []);
  });
});

describe("linkIssues", () => {
  it("turns a bare reference into a link to the issue", () => {
    assert.equal(linkIssues("closes #120", REPO), `closes [#120](${REPO}/issues/120)`);
  });

  it("links every reference in the line", () => {
    assert.equal(
      linkIssues("#1 and #2", REPO),
      `[#1](${REPO}/issues/1) and [#2](${REPO}/issues/2)`,
    );
  });

  it("leaves the text alone when there is no repository URL", () => {
    assert.equal(linkIssues("closes #120", null), "closes #120");
  });
});

describe("parseCommits", () => {
  it("splits a git log stream into commits and counts what it could not read", () => {
    const raw = [
      logRecord("a".repeat(40), "feat(ui): add the console page (#12)"),
      logRecord("b".repeat(40), "Merge pull request #9 from a/b"),
      logRecord("c".repeat(40), "fix(guard): refuse a stale sequence"),
    ].join("");

    const { commits, skipped } = parseCommits(raw);
    assert.equal(skipped, 1);
    assert.equal(commits.length, 2);
    assert.equal(commits[0]!.type, "feat");
    assert.deepEqual(commits[0]!.issues, ["12"]);
    assert.equal(commits[1]!.type, "fix");
  });

  it("returns nothing for empty input", () => {
    const { commits, skipped } = parseCommits("");
    assert.deepEqual(commits, []);
    assert.equal(skipped, 0);
  });
});

describe("groupCommits", () => {
  const commits = [
    { hash: "1", type: "feat", scope: "guard", breaking: false, description: "add a", issues: [] },
    { hash: "2", type: "fix", scope: null, breaking: false, description: "fix a", issues: [] },
    {
      hash: "3",
      type: "docs",
      scope: null,
      breaking: false,
      description: "document a",
      issues: [],
    },
    { hash: "4", type: "chore", scope: null, breaking: false, description: "bump a", issues: [] },
    { hash: "5", type: "wip", scope: null, breaking: false, description: "start a", issues: [] },
  ];

  it("renders the four sections, in order, and drops the empty ones", () => {
    const titles = groupCommits(commits).map((group) => group.title);
    assert.deepEqual(titles, ["Features", "Bug Fixes", "Documentation", "Maintenance"]);
  });

  it("falls back to Maintenance rather than dropping an unknown type", () => {
    const maintenance = groupCommits(commits).find((group) => group.title === "Maintenance");
    if (!maintenance) {
      throw new Error("expected a Maintenance section to be rendered");
    }
    assert.deepEqual(
      maintenance.commits.map((commit) => commit.hash),
      ["4", "5"],
    );
  });

  it("omits a section with nothing in it", () => {
    const titles = groupCommits([commits[1]!]).map((group) => group.title);
    assert.deepEqual(titles, ["Bug Fixes"]);
  });
});

describe("renderChangelog", () => {
  const commits = [
    {
      hash: "552f76b9c1e2a3b4c5d6e7f8091a2b3c4d5e6f70",
      type: "feat",
      scope: "guard",
      breaking: false,
      description: "add rotateAgentKey operation function (#123)",
      issues: ["123"],
    },
    {
      hash: "fb19725a1b2c3d4e5f60718293a4b5c6d7e8f901",
      type: "fix",
      scope: "scval",
      breaking: false,
      description: "support Node webcrypto fallback",
      issues: [],
    },
  ];

  it("renders a Keep a Changelog heading and the section for each type", () => {
    const markdown = renderChangelog({ version: UNRELEASED, commits, repositoryUrl: REPO });
    assert.match(markdown, /^# Changelog\n/);
    assert.match(markdown, /## \[Unreleased\]/);
    assert.match(markdown, /### Features/);
    assert.match(markdown, /### Bug Fixes/);
    assert.doesNotMatch(markdown, /### Documentation/);
  });

  it("links issue references and records the short hash", () => {
    const markdown = renderChangelog({ version: UNRELEASED, commits, repositoryUrl: REPO });
    assert.match(markdown, new RegExp(`\\[#123\\]\\(${REPO}/issues/123\\)`));
    assert.match(markdown, /\(`552f76b`\)/);
  });

  it("does not repeat an issue that the description already linked", () => {
    const markdown = renderChangelog({ version: UNRELEASED, commits, repositoryUrl: REPO });
    assert.equal(markdown.split("/issues/123").length - 1, 1);
  });

  it("carries the scope and a breaking marker into the entry", () => {
    const markdown = renderChangelog({
      version: UNRELEASED,
      repositoryUrl: REPO,
      commits: [{ ...commits[0]!, breaking: true }],
    });
    assert.match(markdown, /- \*\*BREAKING:\*\* \*\*guard\*\*: add rotateAgentKey/);
  });

  it("dates a released version and leaves Unreleased undated", () => {
    const released = renderChangelog({
      version: "0.2.0",
      date: "2026-09-25",
      commits,
      repositoryUrl: REPO,
    });
    assert.match(released, /## \[0\.2\.0\] - 2026-09-25/);

    const unreleased = renderChangelog({ version: UNRELEASED, commits, repositoryUrl: REPO });
    assert.doesNotMatch(unreleased, /## \[Unreleased\] - /);
  });

  it("links an unreleased section back to the last tag", () => {
    const markdown = renderChangelog({
      version: UNRELEASED,
      commits,
      repositoryUrl: REPO,
      previousTag: "v0.1.0",
    });
    assert.match(markdown, new RegExp(`\\[Unreleased\\]: ${REPO}/compare/v0\\.1\\.0\\.\\.\\.HEAD`));
  });

  it("still renders a valid document when there is nothing to record", () => {
    const markdown = renderChangelog({ version: UNRELEASED, commits: [], repositoryUrl: REPO });
    assert.match(markdown, /## \[Unreleased\]/);
    assert.match(markdown, /_Nothing recorded yet\._/);
  });
});
