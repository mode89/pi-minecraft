const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createMinHeap, astar, planPath, goto, GotoError,
} = require("../pathfinder.js");
const { createFakeBot, simulate } = require("./fake-bot.js");

test("empty heap returns undefined and reports size 0", () => {
  const heap = createMinHeap();

  assert.equal(heap.size, 0);
  assert.equal(heap.peek(), undefined);
  assert.equal(heap.pop(), undefined);
  assert.equal(heap.size, 0);
});

test("single element round-trips through push and pop", () => {
  const heap = createMinHeap();

  heap.push(42);
  assert.equal(heap.size, 1);
  assert.equal(heap.peek(), 42);
  assert.equal(heap.size, 1);
  assert.equal(heap.pop(), 42);
  assert.equal(heap.size, 0);
  assert.equal(heap.pop(), undefined);
});

test("popping all items yields ascending order for the default comparator", () => {
  const heap = createMinHeap();
  const input = randomIntegers(500, 12345);

  for (const value of input) heap.push(value);
  assert.equal(heap.size, input.length);

  const output = drain(heap);
  assert.deepEqual(output, [...input].sort((a, b) => a - b));
  assert.equal(heap.size, 0);
});

test("custom comparator orders items max-first", () => {
  const heap = createMinHeap((a, b) => b - a);
  for (const value of [3, 1, 4, 1, 5, 9, 2, 6]) heap.push(value);

  assert.deepEqual(drain(heap), [9, 6, 5, 4, 3, 2, 1, 1]);
});

test("comparator can order objects by a field", () => {
  const heap = createMinHeap((a, b) => a.priority - b.priority);
  heap.push({ priority: 5, label: "five" });
  heap.push({ priority: 1, label: "one" });
  heap.push({ priority: 3, label: "three" });

  assert.deepEqual(drain(heap).map((item) => item.label), [
    "one",
    "three",
    "five",
  ]);
});

test("interleaved pushes and pops always return the current minimum", () => {
  const heap = createMinHeap();
  const ops = scriptedOps(2000, 67890);
  // Reference model: a plain array we keep sorted ascending. Each heap.pop()
  // must equal reference.shift(); each heap.push(v) inserts v in order.
  const reference = [];

  for (const op of ops) {
    if (op.kind === "push") {
      heap.push(op.value);
      insertSorted(reference, op.value);
    } else {
      assert.equal(heap.pop(), reference.shift());
    }
    assert.equal(heap.size, reference.length);
  }
});

test("duplicates all come out (order between equals is unspecified)", () => {
  const heap = createMinHeap();
  for (const value of [2, 1, 2, 1, 2, 1]) heap.push(value);

  assert.deepEqual(drain(heap), [1, 1, 1, 2, 2, 2]);
});

test("peek does not mutate the heap", () => {
  const heap = createMinHeap();
  for (const value of [4, 2, 7, 1, 3]) heap.push(value);

  assert.equal(heap.peek(), 1);
  assert.equal(heap.peek(), 1);
  assert.equal(heap.size, 5);
  assert.equal(heap.pop(), 1);
  assert.equal(heap.size, 4);
});

test("size is exposed as a getter without a setter", () => {
  const heap = createMinHeap();
  heap.push(1);

  const descriptor = Object.getOwnPropertyDescriptor(heap, "size");
  assert.equal(typeof descriptor.get, "function");
  assert.equal(descriptor.set, undefined);
  assert.equal(heap.size, 1);
});

// ---------------------------------------------------------------------------
// astar

test("astar returns a single-node path when start already satisfies the goal", () => {
  const result = astar({
    start: "A",
    isGoal: (node) => node === "A",
    neighbors: () => [],
    heuristic: () => 0,
  });

  assert.equal(result.status, "found");
  assert.deepEqual(result.path, ["A"]);
  assert.equal(result.cost, 0);
});

test("astar finds the path through a linear chain", () => {
  const graph = {
    A: [{ node: "B", cost: 1 }],
    B: [{ node: "C", cost: 1 }],
    C: [{ node: "D", cost: 1 }],
    D: [],
  };
  const result = astar({
    start: "A",
    isGoal: (node) => node === "D",
    neighbors: (node) => graph[node],
    heuristic: () => 0,
  });

  assert.equal(result.status, "found");
  assert.deepEqual(result.path, ["A", "B", "C", "D"]);
  assert.equal(result.cost, 3);
});

test("astar reports exhausted when the goal is unreachable", () => {
  const graph = {
    A: [{ node: "B", cost: 1 }],
    B: [],
    C: [{ node: "D", cost: 1 }],
    D: [],
  };
  const result = astar({
    start: "A",
    isGoal: (node) => node === "D",
    neighbors: (node) => graph[node],
    heuristic: () => 0,
  });

  assert.equal(result.status, "exhausted");
  assert.equal(result.path, null);
  assert.equal(result.cost, null);
});

test("astar finds the shortest path on a grid with a wall", () => {
  // 5x5 grid; '#' cells are blocked. Start at (0,0), goal at (4,4).
  const grid = [
    ".....",
    "...#.",
    "...#.",
    "...#.",
    ".....",
  ];
  const result = astar(gridSearch(grid, { x: 0, y: 0 }, { x: 4, y: 4 }));

  assert.equal(result.status, "found");
  // Manhattan distance is 8; the wall forces no detour because we can pass
  // above or below it at row 0 or row 4.
  assert.equal(result.cost, 8);
  assert.equal(result.path[0].x, 0);
  assert.equal(result.path[0].y, 0);
  assert.equal(result.path.at(-1).x, 4);
  assert.equal(result.path.at(-1).y, 4);
  assert.equal(result.path.length, 9);
});

test("astar relaxes a node when a cheaper path is discovered later", () => {
  // From A, the greedy first reach to D goes A->B->D (cost 10), but the
  // cheaper route is A->C->D (cost 3). Tests that the lazy-deletion path
  // finds the better cost rather than locking in the first-seen.
  const graph = {
    A: [{ node: "B", cost: 1 }, { node: "C", cost: 1 }],
    B: [{ node: "D", cost: 9 }],
    C: [{ node: "D", cost: 2 }],
    D: [],
  };
  const result = astar({
    start: "A",
    isGoal: (node) => node === "D",
    neighbors: (node) => graph[node],
    heuristic: () => 0,
  });

  assert.equal(result.status, "found");
  assert.equal(result.cost, 3);
  assert.deepEqual(result.path, ["A", "C", "D"]);
});

test("a good heuristic expands fewer nodes than h=0 with the same cost", () => {
  const grid = [
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
  ];
  const start = { x: 0, y: 0 };
  const goal = { x: 9, y: 9 };

  const dijkstra = astar({
    ...gridSearch(grid, start, goal),
    heuristic: () => 0,
  });
  const guided = astar(gridSearch(grid, start, goal));

  assert.equal(dijkstra.status, "found");
  assert.equal(guided.status, "found");
  // Both must agree on optimal cost.
  assert.equal(dijkstra.cost, guided.cost);
  // The manhattan heuristic must strictly reduce expansions on open terrain.
  assert.ok(
    guided.stats.expanded < dijkstra.stats.expanded,
    `expected guided (${guided.stats.expanded}) < dijkstra `
      + `(${dijkstra.stats.expanded})`,
  );
});

test("astar reports limit when maxNodes is exceeded", () => {
  const grid = [
    "..........",
    "..........",
    "..........",
    "..........",
    "..........",
  ];
  const result = astar({
    ...gridSearch(grid, { x: 0, y: 0 }, { x: 9, y: 4 }),
    maxNodes: 3,
  });

  assert.equal(result.status, "limit");
  assert.equal(result.path, null);
  assert.equal(result.stats.expanded, 3);
});

test("astar throws the abort reason when the signal is already aborted", () => {
  const controller = new AbortController();
  controller.abort();

  assert.throws(() => astar({
    start: "A",
    isGoal: (node) => node === "Z",
    neighbors: () => [{ node: "B", cost: 1 }],
    heuristic: () => 0,
    signal: controller.signal,
  }), controller.signal.reason);
});

test("astar uses key() so non-primitive nodes are deduped by value", () => {
  // Each call to neighbors() returns fresh object instances. Without a key
  // function these would never compare equal and the search would diverge.
  const result = astar({
    start: { x: 0, y: 0 },
    isGoal: (node) => node.x === 2 && node.y === 0,
    neighbors: (node) => [
      { node: { x: node.x + 1, y: node.y }, cost: 1 },
      { node: { x: node.x, y: node.y + 1 }, cost: 1 },
      { node: { x: node.x - 1, y: node.y }, cost: 1 },
    ],
    heuristic: (node) => Math.abs(2 - node.x) + Math.abs(node.y),
    key: (node) => `${node.x},${node.y}`,
    maxNodes: 200,
  });

  assert.equal(result.status, "found");
  assert.equal(result.cost, 2);
  assert.deepEqual(result.path, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// planPath

test("planPath finds a straight line on flat ground", () => {
  const bot = createFakeBot(flatMap(5, 5));
  const result = planPath(
    bot,
    { x: 0, y: 1, z: 0 },
    { x: 4, y: 1, z: 0 },
  );

  assert.equal(result.status, "found");
  assert.equal(result.cost, 4);
  assert.equal(result.path.length, 5);
  assert.deepEqual(result.path[0], { x: 0, y: 1, z: 0 });
  assert.deepEqual(result.path.at(-1), { x: 4, y: 1, z: 0 });
});

test("planPath routes around a wall", () => {
  // 5x5 floor; wall at z=2, x=1..3 is 2 blocks tall (y=1, y=2). Step-up only
  // handles a 1-block lift, and the head check at p.y+2=3 hits the wall top,
  // so the bot must detour around it.
  const map = flatMap(5, 5);
  for (const x of [1, 2, 3]) map[2][x] = [1, 1, 1];
  const bot = createFakeBot(map);

  const result = planPath(
    bot,
    { x: 2, y: 1, z: 0 },
    { x: 2, y: 1, z: 4 },
  );

  assert.equal(result.status, "found");
  // Manhattan is 4, but the wall forces a detour around x=0 or x=4.
  assert.ok(result.cost > 4, `expected detour cost > 4, got ${result.cost}`);
  for (const node of result.path) {
    if (node.z === 2) {
      assert.ok(
        node.x === 0 || node.x === 4,
        `path crosses wall at ${JSON.stringify(node)}`,
      );
    }
  }
});

test("planPath prefers a diagonal over two cardinal moves on open ground", () => {
  const bot = createFakeBot(flatMap(3, 3));
  const result = planPath(
    bot,
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 1 },
  );

  assert.equal(result.status, "found");
  // One diagonal step at sqrt(2) beats two cardinals at cost 2.
  assert.equal(result.path.length, 2);
  assert.ok(
    Math.abs(result.cost - Math.SQRT2) < 1e-9,
    `expected sqrt(2), got ${result.cost}`,
  );
  assert.deepEqual(result.path.at(-1), { x: 1, y: 1, z: 1 });
});

test("planPath refuses to cut diagonally through a wall corner", () => {
  // 2x2 floor. Block the (1, 0) cell with a 2-tall wall so the diagonal
  // from (0,0) to (1,1) would clip its corner.
  const map = flatMap(2, 2);
  map[0][1] = [1, 1, 1];
  const bot = createFakeBot(map);

  const result = planPath(
    bot,
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 1 },
  );

  assert.equal(result.status, "found");
  // Forced to go through (0,1,1): two cardinal steps, cost 2.
  assert.equal(result.cost, 2);
  assert.deepEqual(result.path, [
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 1, z: 1 },
    { x: 1, y: 1, z: 1 },
  ]);
});

test("planPath handles a single step-up", () => {
  // x=0 floor at y=0 (stand y=1); x=1 step block at y=1 (stand y=2).
  const map = [[[1], [1, 1]]];
  const bot = createFakeBot(map);

  const result = planPath(
    bot,
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 2, z: 0 },
  );

  assert.equal(result.status, "found");
  assert.deepEqual(result.path, [
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 2, z: 0 },
  ]);
});

test("planPath handles step-down within the 3-block limit", () => {
  // x=0 column 3 tall (stand y=3); x=1 column 1 tall (stand y=1). Drop = 2.
  const map = [[[1, 1, 1], [1]]];
  const bot = createFakeBot(map);

  const result = planPath(
    bot,
    { x: 0, y: 3, z: 0 },
    { x: 1, y: 1, z: 0 },
  );

  assert.equal(result.status, "found");
  assert.deepEqual(result.path, [
    { x: 0, y: 3, z: 0 },
    { x: 1, y: 1, z: 0 },
  ]);
});

test("planPath refuses step-down beyond the 3-block limit", () => {
  // x=0 column 5 tall (stand y=5); x=1 column 1 tall (stand y=1). Drop = 4.
  const map = [[[1, 1, 1, 1, 1], [1]]];
  const bot = createFakeBot(map);

  const result = planPath(
    bot,
    { x: 0, y: 5, z: 0 },
    { x: 1, y: 1, z: 0 },
  );

  assert.equal(result.status, "exhausted");
});

test("planPath returns exhausted when the goal is enclosed", () => {
  // 3x3 floor; the four walls around the goal are tall enough that step-up's
  // head clearance (p.y+2) is blocked, so the bot cannot climb over.
  const map = flatMap(3, 3);
  for (const [x, z] of [[0, 1], [2, 1], [1, 0], [1, 2]]) {
    map[z][x] = [1, 1, 1, 1];
  }
  const bot = createFakeBot(map, { spawn: { x: 0.5, y: 1, z: 0.5 } });

  const result = planPath(
    bot,
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 1 },
  );

  assert.equal(result.status, "exhausted");
});

test("planPath treats off-map cells as blocked", () => {
  const bot = createFakeBot(flatMap(3, 3));
  // Goal one block beyond the map edge.
  const result = planPath(
    bot,
    { x: 0, y: 1, z: 0 },
    { x: 5, y: 1, z: 0 },
  );

  assert.equal(result.status, "exhausted");
});

// ---------------------------------------------------------------------------
// goto

test("goto walks a straight path on flat ground", async () => {
  const bot = createFakeBot(flatMap(5, 5));
  const result = await simulate(bot, goto(bot, { x: 4, y: 1, z: 0 }));

  assert.equal(result, undefined);
  assert.equal(Math.floor(bot.entity.position.x), 4);
  assert.equal(Math.floor(bot.entity.position.z), 0);
  // All movement controls released after arrival.
  assert.equal(bot.controlState.forward, false);
  assert.equal(bot.controlState.jump, false);
});

test("goto climbs a single step-up", async () => {
  const map = [[[1], [1, 1]]];
  const bot = createFakeBot(map);
  await simulate(bot, goto(bot, { x: 1, y: 2, z: 0 }));

  assert.equal(Math.floor(bot.entity.position.x), 1);
  assert.equal(Math.floor(bot.entity.position.y), 2);
});

test("goto drops down a step within the limit", async () => {
  const map = [[[1, 1, 1], [1]]];
  const bot = createFakeBot(map);
  await simulate(bot, goto(bot, { x: 1, y: 1, z: 0 }));

  assert.equal(Math.floor(bot.entity.position.x), 1);
  assert.equal(Math.floor(bot.entity.position.y), 1);
});

test("goto throws GotoError(stuck) when a block is placed on the path mid-walk",
  async () => {
    const bot = createFakeBot(flatMap(6, 1));
    let placed = false;
    bot.on("physicsTick", () => {
      // Once the bot has moved past x=1.5, drop a wall at x=3 so the next
      // waypoint becomes unstandable. Without re-validation, the walker
      // would only notice via the 40-tick stuck timer.
      if (!placed && bot.entity.position.x > 1.5) {
        placed = true;
        bot.setBlock({ x: 3, y: 1, z: 0 }, 1);
      }
    });

    await assert.rejects(
      simulate(bot, goto(bot, { x: 5, y: 1, z: 0 })),
      (error) => {
        assert.ok(error instanceof GotoError);
        assert.equal(error.status, "stuck");
        // closest = where the bot actually stopped, distance = remaining gap.
        assert.ok(error.closest.x < 3, `closest.x=${error.closest.x}`);
        assert.ok(error.distance > 0);
        return true;
      },
    );
    // Bot stopped before walking into the new wall.
    assert.ok(bot.entity.position.x < 3, `x=${bot.entity.position.x}`);
    assert.equal(bot.controlState.forward, false);
  });

test("goto throws GotoError(unreachable) when no route exists", async () => {
  // 3x3 floor surrounded by void; goal is far outside the island.
  const bot = createFakeBot(flatMap(3, 3));
  await assert.rejects(
    simulate(bot, goto(bot, { x: 9, y: 1, z: 9 })),
    (error) => {
      assert.ok(error instanceof GotoError);
      assert.equal(error.status, "unreachable");
      // Closest reachable is the island's far corner (2, 1, 2).
      assert.deepEqual(error.closest, { x: 2, y: 1, z: 2 });
      const expected = Math.hypot(9 - 2, 1 - 1, 9 - 2);
      assert.ok(Math.abs(error.distance - expected) < 1e-9);
      return true;
    },
  );
});

test("goto accepts a distance function as the goal", async () => {
  // Target the corner block at (4, 1, 0) by Euclidean distance from the
  // bot's standing position. Anything within 0.5 of the target counts as
  // arrived, which on integer coordinates picks out exactly that block.
  const bot = createFakeBot(flatMap(5, 1));
  const distanceTo = ({ x, y, z }) =>
    Math.hypot(x - 4, y - 1, z - 0);
  await simulate(bot, goto(bot, distanceTo));

  assert.equal(Math.floor(bot.entity.position.x), 4);
  assert.equal(Math.floor(bot.entity.position.z), 0);
});

test("goto throws GotoError(limit) when maxNodes is exceeded", async () => {
  const bot = createFakeBot(flatMap(10, 10));
  await assert.rejects(
    simulate(bot, goto(bot, { x: 9, y: 1, z: 9 }, { maxNodes: 2 })),
    (error) => error instanceof GotoError && error.status === "limit",
  );
});

test("goto rejects with the abort reason when signal is pre-aborted", async () => {
  const bot = createFakeBot(flatMap(5, 5));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    goto(bot, { x: 4, y: 1, z: 0 }, { signal: controller.signal }),
    controller.signal.reason,
  );
  // Bot did not move from spawn.
  assert.equal(bot.entity.position.x, 0.5);
  assert.equal(bot.entity.position.z, 0.5);
});

test("goto rejects on bad arguments", async () => {
  // goto is async, so argument errors surface as promise rejections rather
  // than synchronous throws.
  const bot = createFakeBot(flatMap(3, 3));
  await assert.rejects(
    () => goto(null, { x: 0, y: 1, z: 0 }),
    TypeError,
  );
  await assert.rejects(() => goto(bot, null), TypeError);
  await assert.rejects(
    () => goto(bot, { x: "oops", y: 1, z: 0 }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// Test helpers

// Pop every remaining item from a heap into an array.
function drain(heap) {
  const output = [];
  while (heap.size > 0) output.push(heap.pop());
  return output;
}

// Generate a deterministic array of integers in [0, 1000).
function randomIntegers(count, seed) {
  const rand = mulberry32(seed);
  const values = [];
  for (let i = 0; i < count; i++) values.push(Math.floor(rand() * 1000));
  return values;
}

// Generate a deterministic mix of push/pop operations.
function scriptedOps(count, seed) {
  const rand = mulberry32(seed);
  const ops = [];
  let live = 0;
  for (let i = 0; i < count; i++) {
    // Bias toward pushes early so pop has something to do.
    const wantPush = live === 0 || rand() < 0.6;
    if (wantPush) {
      ops.push({ kind: "push", value: Math.floor(rand() * 10000) });
      live++;
    } else {
      ops.push({ kind: "pop" });
      live--;
    }
  }
  return ops;
}

// Build a flat fake-bot map: a width x depth grid of single solid floor blocks
// at y=0. Every cell uses the shorthand integer form.
function flatMap(width, depth) {
  const map = [];
  for (let z = 0; z < depth; z++) {
    const row = [];
    for (let x = 0; x < width; x++) row.push(1);
    map.push(row);
  }
  return map;
}

// Build astar options for a 4-connected grid where '#' cells are blocked.
function gridSearch(grid, start, goal) {
  const passable = (x, y) => (
    y >= 0 && y < grid.length
    && x >= 0 && x < grid[y].length
    && grid[y][x] !== "#"
  );

  return {
    start,
    isGoal: (node) => node.x === goal.x && node.y === goal.y,
    neighbors: (node) => {
      const out = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = node.x + dx;
        const y = node.y + dy;
        if (passable(x, y)) out.push({ node: { x, y }, cost: 1 });
      }
      return out;
    },
    heuristic: (node) => Math.abs(goal.x - node.x) + Math.abs(goal.y - node.y),
    key: (node) => `${node.x},${node.y}`,
  };
}

// Insert a value into an already-sorted array, preserving ascending order.
function insertSorted(array, value) {
  let lo = 0;
  let hi = array.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (array[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  array.splice(lo, 0, value);
}

// Small deterministic PRNG so tests are reproducible without seed plumbing.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
