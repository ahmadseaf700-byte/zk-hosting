# DragonHost Hosting Agent

This first agent build runs Java Minecraft servers on a user's own Android device through Termux, or on a Linux host. It is separate from the Render web service.

## Requirements

- Node.js 20+
- Java 21 (recommended for current Minecraft releases)
- Enough free RAM and storage for the selected Minecraft version
- A stable internet connection
- Android: Termux from its official F-Droid/GitHub distribution

## Android / Termux setup

```sh
pkg update && pkg upgrade
pkg install nodejs-lts openjdk-21
```

Download this repository or copy `agent/agent.js` to the device. In the folder containing the script:

1. Sign in to DragonHost in the website.
2. Press **ربط جهاز الاستضافة** and copy the six-digit code.
3. Pair the device (replace the URL with the deployed DragonHost URL):

```sh
node agent.js pair 123456 https://YOUR-DRAGONHOST-DOMAIN
node agent.js
```

The agent saves its bearer token in `.dragonhost-agent.json` with owner-only file permissions. Keep this file private. Do not share it or commit it to Git.

By default, server data is stored in `./dragonhost-servers`. You can change this with `DRAGONHOST_SERVERS_DIR`. You can change the maximum Java heap with `DRAGONHOST_HEAP` (default `1536M`).

## Current capabilities

- One-time, five-minute pairing code
- Authenticated heartbeats and task polling
- Downloads Paper, Purpur, or Vanilla Java server jars
- Writes `eula=true` only after the user explicitly accepts Minecraft EULA in the website wizard
- Creates server.properties and launches/stops/restarts Java servers
- Allocates a distinct local TCP port for each server
- Reports task outcomes to the DragonHost API

## Important limitations

- This is an early **Java Edition** agent. Bedrock provisioning is intentionally rejected.
- The agent must remain running for task delivery and process supervision.
- A phone may stop background processes due to Android battery restrictions; exempt Termux from battery optimization.
- A local port does not automatically make a server reachable from the public internet. Carrier NAT, router port forwarding, firewall rules, DNS, and a public ingress/tunnel still need to be configured. The `.dragonhost.net` address is not active until DNS and routing are deployed.
- Keep the device cool, powered, and on Wi-Fi. Mobile hosting performance and reliability depend on the device.
- Do not expose RCON; it is disabled by default.
