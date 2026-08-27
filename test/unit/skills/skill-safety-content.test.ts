import { describe, expect, test } from "bun:test";

const readSkill = async (name: "session-orchestrator" | "session-worker") =>
  (await Bun.file(`${import.meta.dir}/../../../skills/${name}/SKILL.md`).text()).toLowerCase();

function expectConcept(content: string, ...terms: RegExp[]) {
  for (const term of terms) expect(content).toMatch(term);
}

describe("bundled skill safety guidance", () => {
  test("documents the active-only ask/wait workflow and conservative admission semantics", async () => {
    for (const name of ["session-orchestrator", "session-worker"] as const) {
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
    const orchestrator = await readSkill("session-orchestrator");
    const worker = await readSkill("session-worker");
    const corpus = `${orchestrator}\n${worker}`;

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
    for (const name of ["session-orchestrator", "session-worker"] as const) {
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

  test("does not make unsafe capability promises", async () => {
    const corpus = `${await readSkill("session-orchestrator")}\n${await readSkill("session-worker")}`;
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
