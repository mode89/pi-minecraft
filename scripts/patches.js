const fs = require("node:fs");
const path = require("node:path");

const NODE_MODULES = path.join(__dirname, "..", "node_modules");

function main() {
  // Convert yaw and pitch of entities to radians
  patch(
    "mineflayer/lib/plugins/entities.js",
    /sync_entity_position[\s\S]*?entity\.yaw = (packet\.yaw)/,
    "(180 - packet.yaw) * Math.PI/180",
  );
  patch(
    "mineflayer/lib/plugins/entities.js",
    /sync_entity_position[\s\S]*?entity\.pitch = (packet\.pitch)/,
    "-packet.pitch * Math.PI/180",
  );
}

function patch(relPath, regex, replacement) {
  const flags = regex.flags.includes("d") ? regex.flags : regex.flags + "d";
  const re = new RegExp(regex.source, flags);

  const filePath = path.join(NODE_MODULES, relPath);
  const original = fs.readFileSync(filePath, "utf8");
  const match = re.exec(original);

  if (!match) {
    console.log(`patch: ${regex} did not match in ${relPath}, skipping`);
    return;
  }
  if (match.length > 2) {
    throw new Error(`patch: only one capture group allowed in ${regex}`);
  }

  const [start, end] = match.length === 2 ? match.indices[1] : match.indices[0];
  const updated = original.slice(0, start) + replacement + original.slice(end);

  if (updated !== original) {
    fs.writeFileSync(filePath, updated);
    console.log(`patched ${relPath}`);
  }
}

main();
