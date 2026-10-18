import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const instruction = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
const controllerSource = [...instruction.matchAll(/```javascript\r?\n([\s\S]*?)```/gu)]
  .map((match) => match[1])
  .find((source) => source.startsWith("var googleAiPacing ="));
assert.ok(controllerSource, "The browser REPL controller must be available in the delivered instruction.");

/**
 * Execute the actual delivered snippet, rather than a separate test copy.
 * Fake randomness/timers prove the delay boundaries and ordering without
 * sending Google requests or making CI wait for artificial pauses.
 */
const createController = ({ random = () => 0, setTimeout = (done) => done() } = {}) => {
  const context = vm.createContext({ Math: { floor: Math.floor, random }, setTimeout });
  vm.runInContext(controllerSource, context, { timeout: 1_000 });
  return context.googleAiPacing;
};

test("the first question has no delay and the next requires observed completion", async () => {
  let sends = 0;
  const controller = createController({ setTimeout: () => assert.fail("First question must not wait.") });
  assert.throws(() => controller.answerReady(), /GOOGLE_AI_NO_QUESTION_TO_REVIEW/u);
  assert.equal(await controller.submit(() => ++sends), 1);
  await assert.rejects(controller.submit(() => ++sends), /GOOGLE_AI_PREVIOUS_QUESTION_NOT_REVIEWED/u);
  assert.equal(sends, 1);
});

test("each follow-up gets fresh randomness with inclusive 2 and 15 second bounds", async () => {
  const randomValues = [0, 1 - Number.EPSILON, 0.5];
  const delays = [];
  const controller = createController({
    random: () => randomValues.shift(),
    setTimeout: (done, delay) => { delays.push(delay); done(); },
  });
  await controller.submit(() => undefined);
  for (let index = 0; index < 3; index += 1) {
    controller.answerReady();
    await controller.submit(() => undefined);
  }
  assert.deepEqual(delays, [2_000, 15_000, 8_500]);
  assert.equal(randomValues.length, 0);
});

test("a follow-up cannot send before its timer or race another submission", async () => {
  let releaseTimer;
  let sends = 0;
  const controller = createController({ setTimeout: (done) => { releaseTimer = done; } });
  await controller.submit(() => ++sends);
  controller.answerReady();
  const pending = controller.submit(() => ++sends);
  assert.equal(sends, 1);
  assert.throws(() => controller.answerReady(), /GOOGLE_AI_NO_QUESTION_TO_REVIEW/u);
  await assert.rejects(controller.submit(() => ++sends), /GOOGLE_AI_PREVIOUS_QUESTION_NOT_REVIEWED/u);
  releaseTimer();
  assert.equal(await pending, 2);
  await assert.rejects(controller.submit(() => ++sends), /GOOGLE_AI_PREVIOUS_QUESTION_NOT_REVIEWED/u);
  assert.equal(sends, 2);
});

test("completion cannot be acknowledged while a UI submission is still pending", async () => {
  let releaseSubmit;
  const controller = createController();
  const pending = controller.submit(() => new Promise((resolve) => { releaseSubmit = resolve; }));
  assert.throws(() => controller.answerReady(), /GOOGLE_AI_NO_QUESTION_TO_REVIEW/u);
  await assert.rejects(controller.submit(() => undefined), /GOOGLE_AI_PREVIOUS_QUESTION_NOT_REVIEWED/u);
  releaseSubmit();
  await pending;
  controller.answerReady();
});

test("an ambiguous UI error blocks replay until the answer is observed", async () => {
  let attempts = 0;
  const controller = createController();
  await assert.rejects(controller.submit(() => { attempts += 1; throw new Error("UI timeout"); }), /UI timeout/u);
  await assert.rejects(controller.submit(() => ++attempts), /GOOGLE_AI_PREVIOUS_QUESTION_NOT_REVIEWED/u);
  assert.equal(attempts, 1);
  // This explicit transition represents inspecting the original conversation
  // and observing its completed answer, not merely catching the UI error.
  controller.answerReady();
  assert.equal(await controller.submit(() => ++attempts), 2);
});
