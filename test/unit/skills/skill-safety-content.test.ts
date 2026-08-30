import { describe, expect, test } from "bun:test";

const skillNames = ["session-communication", "session-request-participant"] as const;

const readSkill = async (name: (typeof skillNames)[number]) =>
  (await Bun.file(`${import.meta.dir}/../../../skills/${name}/SKILL.md`).text()).toLowerCase();

function expectConcept(content: string, ...terms: RegExp[]) {
  for (const term of terms) expect(content).toMatch(term);
}

describe("bundled skill safety guidance", () => {
  test("documents the active-only ask/wait workflow and conservative admission semantics", async () => {
    for (const name of skillNames) {
      const content = await readSkill(name);
      expectConcept(
        content,
        /session_send[\s\S]{0,300}(queue|wake|resume)/,
        /session_list[\s\S]{0,300}(busy|retry)/,
        /(busy|retry)[\s\S]{0,300}session_(ask|wait)/,
        /admi(t|ssion)[\s\S]{0,180}(does not|never)[\s\S]{0,100}(execution|activation)/,
        /(do not use session_ask[\s\S]{0,100}wake|ask\/wait never wake)/,
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

  test("documents idempotent start, mandatory stop approval, and summary-only export", async () => {
    for (const name of skillNames) {
      const content = await readSkill(name);
      expectConcept(
        content,
        /session_start[\s\S]{0,300}idempotency_key/,
        /same[\s\S]{0,120}(arguments|operation)/,
        /session_stop[\s\S]{0,120}(always|every)[\s\S]{0,100}(user )?approval/,
        /configuration cannot bypass/,
        /session_export[\s\S]{0,180}summary metadata only/,
        /never[\s\S]{0,60}transcript content/,
      );
    }
  });

  test("frames communication as peer-to-peer rather than supervisory", async () => {
    for (const name of skillNames) {
      const content = await readSkill(name);
      expectConcept(
        content,
        /independent[\s\S]{0,120}peer/,
        /either peer[\s\S]{0,180}(initiate|source)/,
        /source and target[\s\S]{0,180}(temporary|one (?:operation|request)|not authority|not ranks)/,
      );
      expect(content).not.toMatch(/\b(?:orchestrator|worker|subordinate)\b/);
    }
  });

  test("does not make unsafe capability promises", async () => {
    const corpus = `${await readSkill("session-communication")}\n${await readSkill("session-request-participant")}`;
    const dangerousClaims = [
      /admission (?:proves|guarantees) (?:activation|execution|completion)/,
      /ask(?:\/wait)? (?:wakes|queues to) (?:an )?idle/,
      /peer content (?:is|can be treated as) trusted/,
      /cancel(?:lation)? retracts (?:an )?admitted/,
      /stop approval (?:can be bypassed|is optional)/,
      /export (?:returns|includes) transcript content/,
      /ambiguous (?:admission|operation) (?:is|can be) automatically retried/,
    ];

    for (const claim of dangerousClaims) expect(corpus).not.toMatch(claim);
  });
});
