# pi-minecraft

Interactive Pi-powered Minecraft bot.

This Pi package adds Minecraft control commands to Pi:

- `/minecraft:start` starts the bot runtime in the background and enables Minecraft operator instructions for future prompts.
- `/minecraft:status` reports whether the background bot is running and reachable.
- `/minecraft:stop` stops the background bot and disables the Minecraft operator instructions.

## Local development

```sh
npm install
npm test
```

Start an ad-hoc local Minecraft server, if needed:

```sh
./scripts/minecraft-server
```

Implementation files:

- `extensions/pi-minecraft.js`: Pi extension entry point.
- `mcbot.js`: managed bot runtime with an HTTP `/eval` control endpoint.
- `system.md`: operator instructions injected while the managed bot is running.

For debugging, start the runtime manually:

```sh
node mcbot.js --server localhost:25565 --http localhost:3000
```

## Pi package usage

Install this repository as a Pi package:

```sh
pi install .
```

Then restart Pi or run `/reload`.

Commands:

```text
/minecraft:start [mcbot args]
/minecraft:status
/minecraft:stop
```

After `/minecraft:start`, normal prompts can directly ask the bot to act in Minecraft while the background runtime is running.

Examples:

```text
/minecraft:start --server localhost:25565 --http localhost:3000
/minecraft:status
collect some wood
/minecraft:stop
```

The background process writes state and logs under `.pi/minecraft/` in the current project.

## Security

The managed bot runtime executes arbitrary JavaScript received by HTTP. Keep `--http` bound to localhost unless you fully trust the network. Game/world changes made by scripts are real and are not rolled back.
