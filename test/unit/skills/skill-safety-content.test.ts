import { describe, expect, test } from "bun:test";

const communicationSkillNames = ["session-communication", "session-request-participant"] as const;
const skillNames = [...communicationSkillNames, "session-locks"] as const;

const readSkill = async (name: (typeof skillNames)[number]) =>
  (await Bun.file(`${import.meta.dir}/../../../skills/${name}/SKILL.md`).text()).toLowerCase();

function expectConcept(content: string, ...terms: RegExp[]) {
  for (const term of terms) expect(content).toMatch(term);
}

describe("bundled skill safety guidance", () => {
  test("documents queue-based ask/wait and public-v2 capability limitations", async () => {
    for (const name of communicationSkillNames) {
      const content = await readSkill(name);
      expectConcept(
        content,
        /session_send[\s\S]{0,300}(queue|wake|resume)/,
        /session_list[\s\S]{0,300}unknown/,
        /admi(t|ssion)[\s\S]{0,180}(does not|never)[\s\S]{0,100}(execution|activation)/,
        /ask\/wait[\s\S]{0,100}(queue|transcript-visible)/,
        /native_unavailable/,
      );
    }
  });

  test("documents trust, recovery, role, and terminal-state boundaries", async () => {
    const communication = await readSkill("session-communication");
    const participant = await readSkill("session-request-participant");
    const corpus = `${communication}\n${participant}`;

    expectConcept(
      corpus,
      /untrusted[\s\S]{0,300}(commands|secrets|links|permissions)/,
      /(invocation loss|backend restart)[\s\S]{0,180}(durable|pending|does not cancel)/,
      /inbox/,
      /outbox/,
      /session_request_ack[\s\S]{0,180}source-only/,
      /session_request_cancel[\s\S]{0,180}source-only/,
      /(late|duplicate)[\s\S]{0,100}(respond|session_respond)[\s\S]{0,180}(terminal|stored)/,
      /cancel[\s\S]{0,180}(cannot|does not)[\s\S]{0,80}retract/,
    );
  });

  test("documents idempotent start, static deny-default stop, and summary-only export", async () => {
    for (const name of communicationSkillNames) {
      const content = await readSkill(name);
      expectConcept(
        content,
        /session_start[\s\S]{0,300}idempotency_key/,
        /same[\s\S]{0,120}(arguments|operation)/,
        /session_stop[\s\S]{0,160}static[\s\S]{0,160}defaults to `deny`/,
        /legacy `ask`[\s\S]{0,40}configuration is rejected/,
        /session_export[\s\S]{0,180}summary metadata only/,
        /never[\s\S]{0,60}transcript content/,
      );
    }
  });

  test("shows the required nested session response shape", async () => {
    const participant = await readSkill("session-request-participant");
    expectConcept(
      participant,
      /`answers` is always a nested array/,
      /outer array[\s\S]{0,100}one entry per question/,
      /"answers": \[\["pass"\]\]/,
    );
  });

  test("frames communication as peer-to-peer rather than supervisory", async () => {
    for (const name of communicationSkillNames) {
      const content = await readSkill(name);
      expectConcept(
        content,
        /independent[\s\S]{0,120}peer/,
        /either peer[\s\S]{0,180}(initiate|source)/,
        /source and target[\s\S]{0,180}(temporary|one (?:operation|request)|not authority|not ranks)/,
      );
      expect(content).not.toMatch(/\bsubordinate\b/);
    }
  });

  test("separates native task children from root communicator workflows", async () => {
    for (const name of communicationSkillNames) {
      const content = await readSkill(name);
      expectConcept(
        content,
        /native `task` child/,
        /task[\s\S]{0,20}result channel/,
        /(do not|never combine)[\s\S]{0,180}foreground task wait[\s\S]{0,240}communicator/,
      );
    }
    const locks = await readSkill("session-locks");
    expectConcept(
      locks,
      /native `task` children[\s\S]{0,180}not offered[\s\S]{0,120}lock[\s\S]{0,20}tools/,
      /independently delegated root[\s\S]{0,120}publish its own lock/,
    );
  });

  test("does not make unsafe capability promises", async () => {
    const corpus = `${await readSkill("session-communication")}\n${await readSkill("session-request-participant")}`;
    const dangerousClaims = [
      /admission (?:proves|guarantees) (?:activation|execution|completion)/,
      /peer content (?:is|can be treated as) trusted/,
      /cancel(?:lation)? retracts (?:an )?admitted/,
      /stop approval (?:can be bypassed|is optional)/,
      /export (?:returns|includes) transcript content/,
      /ambiguous (?:admission|operation) (?:is|can be) automatically retried/,
    ];

    for (const claim of dangerousClaims) expect(corpus).not.toMatch(claim);
  });

  test("documents the complete advisory lock workflow and boundaries", async () => {
    const locks = await readSkill("session-locks");
    expectConcept(
      locks,
      /before the first shared workspace mutation[\s\S]{0,100}session_lock_list/,
      /semantically compare all markdown fields[\s\S]{0,180}title[\s\S]{0,100}description[\s\S]{0,100}instructions/,
      /may overlap[\s\S]{0,80}stop and coordinate/,
      /immediately before mutation[\s\S]{0,100}session_lock_publish/,
      /delegated root[\s\S]{0,100}publish its own lock/,
      /renew[\s\S]{0,100}well before/,
      /expired[\s\S]{0,180}list[\s\S]{0,180}publish a new lock/,
      /release[\s\S]{0,180}(completes|abandoned)[\s\S]{0,180}failure/,
      /ambiguous[\s\S]{0,180}authoritative[\s\S]{0,40}session_lock_list/,
      /untrusted[\s\S]{0,100}grants no authority/,
      /never put secrets[\s\S]{0,120}private transcript/,
      /best-effort hints/,
      /advisory only[\s\S]{0,180}(no enforcement|authorization)/,
    );
  });
});
