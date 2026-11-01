import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const instruction = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
const controllerSource = [...instruction.matchAll(/```javascript\r?\n([\s\S]*?)```/gu)]
  .map((match) => match[1])
  .find((source) => source.startsWith("var yandexPacing ="));
assert.ok(controllerSource, "The browser REPL controller must be available in the delivered instruction.");

/**
 * Execute the actual delivered snippet, rather than a separate test copy.
 * Fake randomness/timers prove the delay boundaries and ordering without
 * sending Yandex requests or making CI wait for artificial pauses.
 */
const createHarness = ({ random = () => 0, deferTimers = false, earlyTimer = false } = {}) => {
  let now = 100;
  const delays = [];
  const timers = [];
  const context = vm.createContext({
    Math: { floor: Math.floor, ceil: Math.ceil, random },
    performance: { now: () => now },
    setTimeout: (done, delay) => {
      delays.push(delay);
      const complete = () => {
        // One deliberately early callback proves that the monotonic deadline,
        // rather than merely an awaited timeout, owns the minimum interval.
        now += earlyTimer && delays.length === 1 ? delay - 1 : delay;
        done();
      };
      if (deferTimers) timers.push(complete);
      else complete();
    },
  });
  vm.runInContext(controllerSource, context, { timeout: 1_000 });
  return {
    controller: context.yandexPacing,
    delays,
    advance: (milliseconds) => { now += milliseconds; },
    releaseTimer: () => timers.shift()(),
  };
};

const observeReady = async ({ controller }) => {
  await controller.observe(() => "Completed search result or Alice answer observed");
  controller.responseReady();
};

test("the first query has no delay and the next requires observed completion", async () => {
  let sends = 0;
  const harness = createHarness();
  const { controller, delays } = harness;
  assert.throws(() => controller.responseReady(), /YANDEX_NO_REQUEST_TO_REVIEW/u);
  assert.equal(await controller.submit(() => ++sends), 1);
  await assert.rejects(controller.submit(() => ++sends), /YANDEX_PREVIOUS_REQUEST_NOT_REVIEWED/u);
  assert.equal(sends, 1);
  assert.deepEqual(delays, []);
  assert.throws(() => controller.responseReady(), /YANDEX_NO_REQUEST_TO_REVIEW/u);
  await observeReady(harness);
});

test("each follow-up gets fresh randomness with inclusive 2 and 15 second bounds", async () => {
  const randomValues = [0, 1 - Number.EPSILON, 0.5];
  const harness = createHarness({ random: () => randomValues.shift() });
  const { controller, delays } = harness;
  await controller.submit(() => undefined);
  for (let index = 0; index < 3; index += 1) {
    await observeReady(harness);
    await controller.submit(() => undefined);
  }
  assert.deepEqual(delays, [2_000, 15_000, 8_500]);
  assert.equal(randomValues.length, 0);
});

test("operator thinking counts both before and after completion acknowledgement", async () => {
  for (const thinkBeforeAcknowledgement of [false, true]) {
    const { controller, delays, advance } = createHarness({ random: () => 1 - Number.EPSILON });
    await controller.submit(() => undefined);
    await controller.observe(() => "Completed search result or Alice answer observed");
    if (thinkBeforeAcknowledgement) advance(60_000);
    controller.responseReady();
    if (!thinkBeforeAcknowledgement) advance(60_000);
    await controller.submit(() => undefined);
    assert.deepEqual(delays, [], "A minute of operator thinking must not acquire another pause.");
  }
});

test("a 10 second interval with 7 seconds already elapsed waits only 3 seconds", async () => {
  const harness = createHarness({ random: () => 8_000 / 13_001 });
  await harness.controller.submit(() => undefined);
  await observeReady(harness);
  harness.advance(7_000);
  await harness.controller.submit(() => undefined);
  assert.deepEqual(harness.delays, [3_000]);
});

test("an early timer callback still cannot submit before the interval deadline", async () => {
  const harness = createHarness({ earlyTimer: true });
  await harness.controller.submit(() => undefined);
  await observeReady(harness);
  await harness.controller.submit(() => undefined);
  assert.deepEqual(harness.delays, [2_000, 1]);
});

test("a follow-up cannot send before its timer or race another submission", async () => {
  let sends = 0;
  const harness = createHarness({ deferTimers: true });
  const { controller } = harness;
  await controller.submit(() => ++sends);
  await observeReady(harness);
  const pending = controller.submit(() => ++sends);
  assert.equal(sends, 1);
  assert.throws(() => controller.responseReady(), /YANDEX_NO_REQUEST_TO_REVIEW/u);
  await assert.rejects(controller.submit(() => ++sends), /YANDEX_PREVIOUS_REQUEST_NOT_REVIEWED/u);
  harness.releaseTimer();
  assert.equal(await pending, 2);
  await assert.rejects(controller.submit(() => ++sends), /YANDEX_PREVIOUS_REQUEST_NOT_REVIEWED/u);
  assert.equal(sends, 2);
});

test("completion cannot be acknowledged while a UI submission is still pending", async () => {
  let releaseSubmit;
  const harness = createHarness();
  const { controller } = harness;
  const pending = controller.submit(() => new Promise((resolve) => { releaseSubmit = resolve; }));
  assert.throws(() => controller.responseReady(), /YANDEX_NO_REQUEST_TO_REVIEW/u);
  await assert.rejects(controller.submit(() => undefined), /YANDEX_PREVIOUS_REQUEST_NOT_REVIEWED/u);
  releaseSubmit();
  await pending;
  await observeReady(harness);
});

test("an ambiguous UI error blocks replay until the search result is observed", async () => {
  let attempts = 0;
  const harness = createHarness();
  const { controller } = harness;
  await assert.rejects(controller.submit(() => { attempts += 1; throw new Error("UI timeout"); }), /UI timeout/u);
  await assert.rejects(controller.submit(() => ++attempts), /YANDEX_PREVIOUS_REQUEST_NOT_REVIEWED/u);
  assert.equal(attempts, 1);
  // This explicit transition represents inspecting the original search page or Alice conversation
  // and observing its completed result/answer, not merely catching the UI error.
  await observeReady(harness);
  assert.equal(await controller.submit(() => ++attempts), 2);
});

test("failed observation cannot acknowledge readiness using an older snapshot", async () => {
  const { controller } = createHarness();
  await controller.submit(() => undefined);
  await controller.observe(() => "Completed search result or Alice answer observed");
  await assert.rejects(controller.observe(() => { throw new Error("Snapshot unavailable"); }), /Snapshot unavailable/u);
  assert.throws(() => controller.responseReady(), /YANDEX_NO_REQUEST_TO_REVIEW/u);
});

/**
 * One delivered controller spans search and the AI conversation. Switching tabs
 * must preserve its completion fence and delay; Alice follow-ups are new sends,
 * even when the visible conversation and its context stay the same.
 */
test("search, Alice and same-chat clarifications share one completion fence and clock", async () => {
  const harness = createHarness();
  const sent = [];
  for (const request of ["search", "Alice question", "answer Alice clarification", "challenge Alice answer"]) {
    await harness.controller.submit(() => sent.push(request));
    await assert.rejects(harness.controller.submit(() => sent.push("premature follow-up")),
      /YANDEX_PREVIOUS_REQUEST_NOT_REVIEWED/u);
    await observeReady(harness);
  }
  assert.deepEqual(sent, ["search", "Alice question", "answer Alice clarification", "challenge Alice answer"]);
  assert.deepEqual(harness.delays, [2_000, 2_000, 2_000]);
});

test("an unknown Alice send cannot be bypassed by switching back to search", async () => {
  const { controller } = createHarness();
  let sends = 0;
  await assert.rejects(controller.submit(() => {
    sends += 1;
    throw new Error("Alice UI outcome unknown");
  }), /Alice UI outcome unknown/u);
  // A fresh tab or mode cannot create authority to replay the uncertain send.
  await assert.rejects(controller.submit(() => { sends += 1; }), /YANDEX_PREVIOUS_REQUEST_NOT_REVIEWED/u);
  assert.equal(sends, 1);
});
