const assert = require("node:assert/strict");
const test = require("node:test");

const { createFakeBot, simulate } = require("./fake-bot.js");

// ---------------------------------------------------------------------------
// blockAt and map shape

test("integer cell N is shorthand for [N]", () => {
  const bot = createFakeBot([[1]]);

  assert.equal(bot.blockAt({ x: 0, y: 0, z: 0 }).name, "stone");
  assert.equal(bot.blockAt({ x: 0, y: 1, z: 0 }).name, "air");
});

test("array cells stack from y=0 upward; air above the column", () => {
  const bot = createFakeBot([[[1, 1, 2]]]);

  assert.equal(bot.blockAt({ x: 0, y: 0, z: 0 }).name, "stone");
  assert.equal(bot.blockAt({ x: 0, y: 1, z: 0 }).name, "stone");
  assert.equal(bot.blockAt({ x: 0, y: 2, z: 0 }).name, "lava");
  assert.equal(bot.blockAt({ x: 0, y: 3, z: 0 }).name, "air");
  assert.equal(bot.blockAt({ x: 0, y: 99, z: 0 }).name, "air");
});

test("y < 0 is air everywhere", () => {
  const bot = createFakeBot([[1]]);

  assert.equal(bot.blockAt({ x: 0, y: -1, z: 0 }).name, "air");
  assert.equal(bot.blockAt({ x: 0, y: -100, z: 0 }).name, "air");
});

test("blockAt returns null outside the map in x or z", () => {
  const bot = createFakeBot([[1, 1], [1, 1]]);

  assert.equal(bot.blockAt({ x: -1, y: 0, z: 0 }), null);
  assert.equal(bot.blockAt({ x: 2, y: 0, z: 0 }), null);
  assert.equal(bot.blockAt({ x: 0, y: 0, z: -1 }), null);
  assert.equal(bot.blockAt({ x: 0, y: 0, z: 2 }), null);
});

test("fractional positions floor to the containing cell", () => {
  const bot = createFakeBot([[1, 0]]);

  assert.equal(bot.blockAt({ x: 0.99, y: 0.5, z: 0.0 }).name, "stone");
  assert.equal(bot.blockAt({ x: 1.01, y: 0.5, z: 0.0 }).name, "air");
});

test("non-integer or negative cell values are rejected", () => {
  assert.throws(() => createFakeBot([[1.5]]), /non-negative integer/);
  assert.throws(() => createFakeBot([[-1]]), /non-negative integer/);
  assert.throws(() => createFakeBot([[[1, "x"]]]), /non-negative integer/);
});

test("ragged rows are rejected", () => {
  assert.throws(() => createFakeBot([[1, 1], [1]]), /width/);
});

// ---------------------------------------------------------------------------
// Spawn and teleport

test("default spawn lands on top of the highest solid block at (0, 0)", () => {
  const bot = createFakeBot([[[1, 1, 1]]]);
  assert.deepEqual(bot.entity.position, { x: 0.5, y: 3, z: 0.5 });
  assert.equal(bot.entity.onGround, true);
});

test("default spawn over an empty column yields y=0 and onGround=false", () => {
  const bot = createFakeBot([[0]]);
  assert.equal(bot.entity.position.y, 0);
  assert.equal(bot.entity.onGround, false);
});

test("explicit spawn override is honored verbatim", () => {
  const bot = createFakeBot([[1]], { spawn: { x: 0.5, y: 5, z: 0.5 } });
  assert.deepEqual(bot.entity.position, { x: 0.5, y: 5, z: 0.5 });
  assert.equal(bot.entity.onGround, false);
});

test("teleport updates onGround based on the new column", () => {
  const bot = createFakeBot([[1, 0]]);
  bot.teleport({ x: 1.5, y: 5, z: 0.5 });
  assert.equal(bot.entity.onGround, false);
  bot.teleport({ x: 0.5, y: 1, z: 0.5 });
  assert.equal(bot.entity.onGround, true);
});

// ---------------------------------------------------------------------------
// Physics: gravity

test("gravity falls per tick and snaps onto a solid floor", () => {
  const bot = createFakeBot([[1]], { spawn: { x: 0.5, y: 5, z: 0.5 } });

  bot.tick();
  assert.equal(bot.entity.position.y, 4.5);
  bot.tick();
  assert.equal(bot.entity.position.y, 4.0);
  // Continue falling until landing.
  for (let i = 0; i < 10 && !bot.entity.onGround; i++) bot.tick();
  assert.equal(bot.entity.onGround, true);
  assert.equal(bot.entity.position.y, 1);
});

test("a bot already on the ground does not fall", () => {
  const bot = createFakeBot([[1]]);
  const before = bot.entity.position.y;
  bot.tick();
  assert.equal(bot.entity.position.y, before);
  assert.equal(bot.entity.onGround, true);
});

// ---------------------------------------------------------------------------
// Physics: walking

test("yaw=0 faces -z (north) per the mineflayer bot.entity convention", () => {
  const bot = createFakeBot([[1, 1], [1, 1]]);
  bot.teleport({ x: 0.5, y: 1, z: 1.5 });
  bot.entity.yaw = 0;
  bot.setControlState("forward", true);

  bot.tick();
  assert.equal(bot.entity.position.x, 0.5);
  assert.equal(bot.entity.position.z, 1.25);
});

test("lookAt aims yaw so forward motion advances toward the target", () => {
  // Floor extends along +x; walking should reach the eastern column.
  const bot = createFakeBot([[1, 1, 1]]);
  bot.lookAt({ x: 5, y: 1, z: 0.5 });
  bot.setControlState("forward", true);

  bot.tick();
  assert.equal(bot.entity.position.x, 0.75);
  bot.tick();
  assert.equal(bot.entity.position.x, 1.0);
  assert.equal(bot.entity.onGround, true);
});

test("non-cardinal yaw produces diagonal motion of magnitude walkSpeed", () => {
  // Open 3x3 floor so any horizontal direction is unobstructed.
  const bot = createFakeBot([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
  bot.teleport({ x: 1.5, y: 1, z: 1.5 });
  bot.entity.yaw = Math.PI / 4;  // halfway between yaw=0 (-z) and yaw=π/2 (-x)
  bot.setControlState("forward", true);

  bot.tick();
  const dx = bot.entity.position.x - 1.5;
  const dz = bot.entity.position.z - 1.5;
  // Equal-magnitude components into the -x/-z quadrant.
  assert.ok(dx < 0 && dz < 0);
  assert.ok(Math.abs(Math.abs(dx) - Math.abs(dz)) < 1e-9);
  // Total step length is walkSpeed.
  assert.ok(Math.abs(Math.hypot(dx, dz) - bot.simulation.walkSpeed) < 1e-9);
});

test("lookAt at a target below sets pitch positive (looking down)", () => {
  const bot = createFakeBot([[1]], { spawn: { x: 0.5, y: 5, z: 0.5 } });
  bot.lookAt({ x: 0.5, y: 1, z: 0.5 });
  assert.ok(bot.entity.pitch > 0);
});

test("walking is blocked by a solid wall at the next cell", () => {
  // Two-cell-wide floor along +x; a 2-tall wall at x=1 blocks horizontal entry.
  const bot = createFakeBot([[[1], [1, 1, 1]]]);
  bot.lookAt({ x: 5, y: 1, z: 0.5 });
  bot.setControlState("forward", true);

  for (let i = 0; i < 10; i++) bot.tick();
  assert.ok(bot.entity.position.x < 1.0);
  assert.ok(bot.entity.position.x >= 0.5);
});

// ---------------------------------------------------------------------------
// Physics: step-up

test("forward + jump rises onto a 1-block ledge", () => {
  // Floor at x=0; ledge of height 1 at x=1 (two stacked blocks).
  const bot = createFakeBot([[[1], [1, 1]]]);
  bot.lookAt({ x: 5, y: 1, z: 0.5 });
  bot.setControlState("forward", true);
  bot.setControlState("jump", true);

  for (let i = 0; i < 20; i++) {
    bot.tick();
    if (bot.entity.position.y === 2 && bot.entity.position.x >= 1.0) break;
  }
  assert.equal(bot.entity.position.y, 2);
  assert.ok(bot.entity.position.x >= 1.0);
  assert.equal(bot.entity.onGround, true);
});

test("step-up is refused when there is no head clearance above the ledge", () => {
  // Ledge at x=1 with a ceiling block above the destination's head.
  const bot = createFakeBot([[[1], [1, 1, 0, 1]]]);
  bot.lookAt({ x: 5, y: 1, z: 0.5 });
  bot.setControlState("forward", true);
  bot.setControlState("jump", true);

  for (let i = 0; i < 20; i++) bot.tick();
  assert.equal(bot.entity.position.y, 1);
  assert.ok(bot.entity.position.x < 1.0);
});

test("jump alone does not lift the bot", () => {
  const bot = createFakeBot([[1]]);
  bot.setControlState("jump", true);
  for (let i = 0; i < 5; i++) bot.tick();
  assert.equal(bot.entity.position.y, 1);
});

// ---------------------------------------------------------------------------
// Control state validation

test("setControlState rejects unknown control names", () => {
  const bot = createFakeBot([[1]]);
  assert.throws(() => bot.setControlState("teleport", true), /unknown/);
});

test("clearControlStates resets every control to false", () => {
  const bot = createFakeBot([[1]]);
  bot.setControlState("forward", true);
  bot.setControlState("jump", true);
  bot.clearControlStates();
  assert.equal(bot.controlState.forward, false);
  assert.equal(bot.controlState.jump, false);
});

// ---------------------------------------------------------------------------
// Tick model: waitForTicks and simulate

test("waitForTicks resolves after exactly N ticks", async () => {
  const bot = createFakeBot([[1]]);
  let resolved = false;
  bot.waitForTicks(3).then(() => { resolved = true; });

  bot.tick();
  await Promise.resolve();
  assert.equal(resolved, false);
  bot.tick();
  await Promise.resolve();
  assert.equal(resolved, false);
  bot.tick();
  await Promise.resolve();
  assert.equal(resolved, true);
});

test("waitForTicks(0) resolves without a tick", async () => {
  const bot = createFakeBot([[1]]);
  await bot.waitForTicks(0);
});

test("physicsTick is emitted once per tick", () => {
  const bot = createFakeBot([[1]]);
  let count = 0;
  bot.on("physicsTick", () => count++);
  bot.tick();
  bot.tick();
  bot.tick();
  assert.equal(count, 3);
});

test("simulate ticks until the work promise settles", async () => {
  const bot = createFakeBot([[1]]);
  let count = 0;
  bot.on("physicsTick", () => count++);

  await simulate(bot, bot.waitForTicks(5));
  assert.equal(count, 5);
});

test("simulate throws when work does not settle within maxTicks", async () => {
  const bot = createFakeBot([[1]]);
  await assert.rejects(
    simulate(bot, bot.waitForTicks(100), { maxTicks: 10 }),
    /not settled/,
  );
});

test("simulate rethrows errors raised by the work promise", async () => {
  const bot = createFakeBot([[1]]);
  const work = bot.waitForTicks(2).then(() => { throw new Error("boom"); });
  await assert.rejects(simulate(bot, work), /boom/);
});
