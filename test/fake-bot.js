// Deterministic, tick-driven fake mineflayer bot for tests.
//
// Map shape: `map[z][x]` is the column at world (x, *, z). A column is one of:
//   - integer N: shorthand for [N], i.e. one block of type N at y=0.
//   - integer[]: explicit stack, [a, b, c] places type a at y=0, b at y=1, ...
//
// y < 0 is treated as air everywhere. (x, z) outside the map → blockAt
// returns null and physics treats the cell as solid (impassable).
//
// Block type 0 is air; 1 is stone (solid). Additional types can be supplied
// via `options.blocks`. Only the registry's `boundingBox` field affects
// physics; `name` is exposed via blockAt for the planner.
//
// Yaw and pitch follow mineflayer's bot.entity convention: radians, yaw=0
// faces -z (north), and pitch>0 looks down. lookAt() and cardinalFromYaw()
// agree on this so motion follows the look direction.
//
// Physics is intentionally minimal — just enough to drive walkPath:
//   - Walking: when `forward` is held and the bot is on the ground, advance
//     `walkSpeed` blocks per tick along the cardinal nearest the current yaw.
//   - Step-up: when walking would collide with a 1-block obstacle and `jump`
//     is held, rise one block and continue. Jump without an obstacle does
//     nothing (no jump arcs).
//   - Gravity: when not on the ground, fall `fallSpeed` per tick, snapping
//     onto the next solid floor.
// Momentum, swimming, and hazard interactions are not modeled. Diagonal
// motion works (yaw is not quantized) but the collision check only inspects
// the destination cell, so a diagonal step could clip the corner of a wall.
// The walker is expected to drive cardinal moves via lookAt, in which case
// motion stays axis-aligned and corner-clipping cannot arise.

const EventEmitter = require("node:events");

// ---------------------------------------------------------------------------
// Public API

// Default block type registry. Callers extend via `options.blocks`.
const DEFAULT_BLOCKS = {
  0: { name: "air",   boundingBox: "empty" },
  1: { name: "stone", boundingBox: "block" },
  2: { name: "lava",  boundingBox: "empty" },
  3: { name: "water", boundingBox: "empty" },
};

// Build a fresh fake bot bound to a specific map.
function createFakeBot(map, options = {}) {
  const blocks = { ...DEFAULT_BLOCKS, ...(options.blocks || {}) };
  const grid = parseMap(map);
  const simulation = {
    walkSpeed: options.walkSpeed ?? 0.25,
    fallSpeed: options.fallSpeed ?? 0.5,
    stepHeight: options.stepHeight ?? 1,
  };
  const controlStates = {
    forward: false, back: false, left: false, right: false,
    jump: false, sprint: false, sneak: false,
  };
  const tickWaits = [];
  const entity = {
    position: defaultSpawn(grid, blocks, options.spawn),
    yaw: 0,
    pitch: 0,
    onGround: false,
  };

  const bot = new EventEmitter();
  bot.entity = entity;
  bot.simulation = simulation;
  bot.controlState = controlStates;     // exposed for assertions / debugging

  bot.blockAt = (pos) => blockAt(grid, blocks, pos);

  bot.setControlState = (state, value) => {
    if (!Object.hasOwn(controlStates, state)) {
      throw new Error(`unknown control state: ${state}`);
    }
    controlStates[state] = !!value;
  };

  bot.clearControlStates = () => {
    for (const key of Object.keys(controlStates)) controlStates[key] = false;
  };

  bot.lookAt = (target /* , force */) => {
    const dx = target.x - entity.position.x;
    const dy = target.y - entity.position.y;
    const dz = target.z - entity.position.z;
    // Match bot.entity's convention: yaw=0 faces -z, pitch>0 looks down.
    entity.yaw = Math.atan2(-dx, -dz);
    entity.pitch = Math.atan2(-dy, Math.hypot(dx, dz));
    return Promise.resolve();
  };

  bot.look = (yaw, pitch /* , force */) => {
    entity.yaw = yaw;
    entity.pitch = pitch;
    return Promise.resolve();
  };

  bot.waitForTicks = (n) => {
    if (n <= 0) return Promise.resolve();
    return new Promise((resolve) => tickWaits.push({ remaining: n, resolve }));
  };

  bot.tick = () => {
    stepPhysics(grid, blocks, entity, controlStates, simulation);
    for (let i = tickWaits.length - 1; i >= 0; i--) {
      tickWaits[i].remaining -= 1;
      if (tickWaits[i].remaining <= 0) {
        const { resolve } = tickWaits[i];
        tickWaits.splice(i, 1);
        resolve();
      }
    }
    bot.emit("physicsTick");
  };

  bot.teleport = (pos) => {
    entity.position = { x: pos.x, y: pos.y, z: pos.z };
    entity.onGround = isOnGround(grid, blocks, entity.position);
  };

  bot.setBlock = (pos, typeId) => {
    requireBlockId(typeId, "setBlock typeId");
    if (!Object.hasOwn(blocks, typeId)) {
      throw new Error(`unknown block type: ${typeId}`);
    }
    setBlockAt(grid, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), typeId);
  };

  entity.onGround = isOnGround(grid, blocks, entity.position);
  return bot;
}

// Tick `bot` until `work` settles or `maxTicks` ticks have elapsed.
//
// Drains pending microtasks between ticks so awaits inside the work promise
// observe each tick before the next one fires. Throws on timeout; rethrows
// any error from `work`.
async function simulate(bot, work, { maxTicks = 2000 } = {}) {
  let settled = false;
  let result;
  let error;
  Promise.resolve(work).then(
    (value) => { settled = true; result = value; },
    (cause) => { settled = true; error = cause; },
  );

  for (let i = 0; i < maxTicks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (settled) break;
    bot.tick();
  }
  await new Promise((resolve) => setImmediate(resolve));

  if (!settled) {
    throw new Error(`simulate: not settled after ${maxTicks} ticks`);
  }
  if (error) throw error;
  return result;
}

// ---------------------------------------------------------------------------
// Map parsing

// Validate the input map and return a normalized grid where every column is
// an explicit integer array.
function parseMap(map) {
  if (!Array.isArray(map)) throw new TypeError("map must be a 2D array");

  let width = null;
  const grid = [];
  for (let z = 0; z < map.length; z++) {
    const row = map[z];
    if (!Array.isArray(row)) {
      throw new TypeError(`map[${z}] must be an array`);
    }
    if (width === null) width = row.length;
    else if (row.length !== width) {
      throw new RangeError(
        `map[${z}] width ${row.length} != ${width}`,
      );
    }

    const gridRow = [];
    for (let x = 0; x < row.length; x++) {
      gridRow.push(normalizeColumn(row[x], x, z));
    }
    grid.push(gridRow);
  }
  return grid;
}

// Coerce a single cell to a fully-explicit column array, validating types.
function normalizeColumn(cell, x, z) {
  if (typeof cell === "number") {
    requireBlockId(cell, `map[${z}][${x}]`);
    return [cell];
  }
  if (Array.isArray(cell)) {
    for (let y = 0; y < cell.length; y++) {
      requireBlockId(cell[y], `map[${z}][${x}][${y}]`);
    }
    return cell.slice();
  }
  throw new TypeError(
    `map[${z}][${x}] must be an integer or integer array`,
  );
}

// Throw unless `value` is a non-negative integer.
function requireBlockId(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

// ---------------------------------------------------------------------------
// Block lookup

// Look up the block descriptor at the integer cell containing `pos`.
function blockAt(grid, blocks, pos) {
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const z = Math.floor(pos.z);
  const type = blockTypeAt(grid, x, y, z);
  return type === null ? null : blocks[type];
}

// Overwrite the block at (x, y, z), extending the column with air as needed.
// Throws if (x, z) is out of map bounds or y is negative.
function setBlockAt(grid, x, y, z, typeId) {
  if (z < 0 || z >= grid.length) {
    throw new RangeError(`setBlock: z=${z} out of bounds`);
  }
  const row = grid[z];
  if (x < 0 || x >= row.length) {
    throw new RangeError(`setBlock: x=${x} out of bounds`);
  }
  if (y < 0) throw new RangeError(`setBlock: y=${y} must be >= 0`);
  const column = row[x];
  while (column.length <= y) column.push(0);
  column[y] = typeId;
}

// Return the integer block type at (x, y, z), or null if (x, z) is OOB.
function blockTypeAt(grid, x, y, z) {
  if (z < 0 || z >= grid.length) return null;
  const row = grid[z];
  if (x < 0 || x >= row.length) return null;
  if (y < 0) return 0;
  const column = row[x];
  if (y >= column.length) return 0;
  return column[y];
}

// True if the cell at (x, y, z) collides with the bot. OOB counts as solid.
function isSolid(grid, blocks, x, y, z) {
  const type = blockTypeAt(grid, x, y, z);
  if (type === null) return true;
  return blocks[type].boundingBox === "block";
}

// ---------------------------------------------------------------------------
// Positioning

// Pick a spawn point: explicit override, else top of column (0, 0).
function defaultSpawn(grid, blocks, override) {
  if (override) return { x: override.x, y: override.y, z: override.z };
  if (grid.length === 0 || grid[0].length === 0) {
    return { x: 0.5, y: 0, z: 0.5 };
  }
  const column = grid[0][0];
  let y = 0;
  for (let i = column.length - 1; i >= 0; i--) {
    if (blocks[column[i]].boundingBox === "block") { y = i + 1; break; }
  }
  return { x: 0.5, y, z: 0.5 };
}

// True iff the bot is resting flush on top of a solid block.
function isOnGround(grid, blocks, position) {
  const epsilon = 1e-9;
  const yFrac = position.y - Math.floor(position.y);
  if (yFrac > epsilon && yFrac < 1 - epsilon) return false;
  const fy = Math.round(position.y);
  return isSolid(
    grid, blocks,
    Math.floor(position.x), fy - 1, Math.floor(position.z),
  );
}

// ---------------------------------------------------------------------------
// Physics

// Run one physics step on `entity` using the current control state.
function stepPhysics(grid, blocks, entity, controls, simulation) {
  if (!isOnGround(grid, blocks, entity.position)) {
    applyGravity(grid, blocks, entity, simulation);
  } else if (controls.forward) {
    applyWalk(grid, blocks, entity, controls, simulation);
  }
  entity.onGround = isOnGround(grid, blocks, entity.position);
}

// Drop the bot toward the nearest solid floor below.
function applyGravity(grid, blocks, entity, simulation) {
  const { position } = entity;
  const fx = Math.floor(position.x);
  const fz = Math.floor(position.z);
  const startY = Math.floor(position.y) - 1;
  // Bound the search so a bottomless pit does not loop forever; tests that
  // need infinite falls can rely on simulate's maxTicks instead.
  const limit = startY - 256;
  let landY = null;
  for (let y = startY; y >= limit; y--) {
    if (isSolid(grid, blocks, fx, y, fz)) { landY = y + 1; break; }
  }

  let newY = position.y - simulation.fallSpeed;
  if (landY !== null && newY <= landY) newY = landY;
  position.y = newY;
}

// Move the bot one walking step, applying step-up if the path is blocked.
function applyWalk(grid, blocks, entity, controls, simulation) {
  const { position } = entity;
  const dir = directionFromYaw(entity.yaw);
  const newX = position.x + dir.dx * simulation.walkSpeed;
  const newZ = position.z + dir.dz * simulation.walkSpeed;
  const fx = Math.floor(newX);
  const fz = Math.floor(newZ);
  const fy = Math.floor(position.y);

  const feetBlocked = isSolid(grid, blocks, fx, fy, fz);
  const headBlocked = isSolid(grid, blocks, fx, fy + 1, fz);
  if (!feetBlocked && !headBlocked) {
    position.x = newX;
    position.z = newZ;
    return;
  }

  if (!controls.jump || simulation.stepHeight < 1) return;

  // Step-up: the obstacle becomes the new floor; require clearance for the
  // bot's new feet, new head, and current head as it rises.
  const stepFeetBlocked = isSolid(grid, blocks, fx, fy + 1, fz);
  const stepHeadBlocked = isSolid(grid, blocks, fx, fy + 2, fz);
  const overheadBlocked = isSolid(
    grid, blocks, Math.floor(position.x), fy + 2, Math.floor(position.z),
  );
  if (!feetBlocked || stepFeetBlocked || stepHeadBlocked || overheadBlocked) {
    return;
  }

  position.x = newX;
  position.y = fy + 1;
  position.z = newZ;
}

// Compute the horizontal unit direction implied by a yaw angle.
//
// Convention matches mineflayer's bot.entity.yaw: radians, yaw=0 faces -z
// (north), advancing through -x (west), +z (south), +x (east). Pitch is
// ignored; the bot walks horizontally regardless of where it is looking.
function directionFromYaw(yaw) {
  return { dx: -Math.sin(yaw), dz: -Math.cos(yaw) };
}

// ---------------------------------------------------------------------------

module.exports = {
  createFakeBot,
  simulate,
};
