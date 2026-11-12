![Logo](admin/vistapool.png)

# ioBroker.vistapool

[![NPM version](https://img.shields.io/npm/v/iobroker.vistapool.svg)](https://www.npmjs.com/package/iobroker.vistapool)
[![Downloads](https://img.shields.io/npm/dm/iobroker.vistapool.svg)](https://www.npmjs.com/package/iobroker.vistapool)
![Test and Release](https://github.com/RePa02/ioBroker.vistapool/workflows/Test%20and%20Release/badge.svg)

**[Deutsche Anleitung](docs/de/README.md)**

Cloud adapter for pool controllers by **Vistapool / Hayward AquaRite / Sugar Valley** (also sold as Kripsol, Dagen, Poolwatch, Oxilife, Hidrolife, …) via the Vistapool account. No extra hardware is needed – the Wi-Fi module of the controller is enough.

> Status: **beta.** Tested on one installation (hydrolysis in %, pH acid, redox, single speed pump, no backwash). Feedback from other setups is very welcome, see [Help with other controllers](#help-with-other-controllers).

## Features

- Reads **all values** of the controller. Modules the controller does not have are not created.
- **Push updates** like the Vistapool app: changes arrive within seconds. If push is unavailable, the adapter polls automatically (default 30 s) and switches back to push as soon as possible.
- **Control:** filtration on/off, pump mode and speed, time windows, heating and smart temperatures, hydrolysis/electrolysis set point, boost, cover, pH and redox set points, relays AUX 1–4 (mode, schedule, timer, linked), light (on/off, mode, schedule), LED colour change, clock sync.
- **Instance page** with the same settings as the Vistapool web app (see below).
- Writing works from the instance page **and** via the states (`ack=false`), i.e. from scripts, Blockly, VIS or Alexa.
- **Reliable commands** for controllers with poor Wi-Fi:
  - Writes within one second are merged into one command per settings branch, at most 6 commands per minute, 3 s apart (the controller drops off Wi-Fi after bursts).
  - Every command is checked for confirmation. If the controller was offline, it is sent again when it is back (at most twice). Commands older than 10 minutes (configurable) are dropped instead of switching at an unexpected time.
  - Right before a command the current state is read, so changes made in the app in the meantime are not overwritten.
  - Commands the controller ignores in its current mode (e.g. light on while the light mode is auto) are not repeated; a hint is logged.
- **Automatic clock sync:** the controller clock drifts and does not know daylight saving time; time windows would run off. The adapter sets the clock when it deviates more than 3 minutes (configurable, at most every 6 hours).
- **Garbage filter:** while switching, the cloud briefly reports nonsense values (e.g. `interval1.to = -520093692`). They are ignored and never sent back to the controller.
- Status states per pool: online, offline since, last report, pending commands, last command and its status, clock deviation.
- Optional mirror of all raw cloud fields under `raw.*` for troubleshooting.

## Instance page

| Tab | Content |
|---|---|
| Connection | Account, "Test connection" (works before saving), push / poll interval, command expiry, raw mirror, clock sync and time zone |
| Pool | Pool selection, detected equipment, "What is connected where?", sync clock now |
| Pump & heating | Pump mode (manual, auto, heat, smart, intel) with the matching fields: time windows 1–3, speed (variable speed pumps only), heating, smart temperatures and frost protection, intel temperature and hours |
| Light | Manual on/off or schedule with repetition |
| Relays | AUX 1–4: use in ioBroker (e.g. heat pump), name in the controller, mode manual / auto (2 time windows) / timer (run time, key) / linked (signal, delay, polarity) / linked + schedule |
| Water care | Hydrolysis/electrolysis (production, cover + reduction, boost), pH, redox, chlorine and conductivity set points – only what the controller has |
| Backwash | Only visible if available |

- The pool settings are loaded from the controller when the page opens; they are not stored in the instance.
- Every tab has its own **"Send to pool"** button with confirmation. Only fields that differ from the controller are sent; the result is shown below the button.
- **"Save"** only stores adapter settings (account, intervals, relay use, boost behaviour, clock).

Requires Admin ≥ 7.6.20 and a running instance.

## Installation

The adapter is not in the ioBroker repository yet. Install the test version from GitHub:

- **Admin:** Adapters → expert mode → "Install from custom URL" (cat icon) → tab "Custom" → `https://github.com/RePa02/ioBroker.vistapool` → Install, then add an instance.
- **Console:** `iobroker url https://github.com/RePa02/ioBroker.vistapool`, then `iobroker add vistapool` (first time only).

Enter e-mail and password of your Vistapool account (same as in the app) in the instance settings. The password is stored encrypted.

## States

```
vistapool.0.info.connection           cloud reachable (push or poll)
vistapool.0.info.push                 push updates active
vistapool.0.<poolId>                  device = pool (name from the app)
  ├─ measure.*      temperature, pH, redox, chlorine, conductivity, production
  ├─ status.*       filtration/heating/dosing pumps running
  ├─ alarm.*        flow, tanks, pump alarm
  ├─ filtration.*   on/off, mode, speed, time windows 1–3 (HH:MM), intelHours, intelTemp [writable]
  ├─ heating.* / smart.*  climate, temperature limits                [writable]
  ├─ electrolysis.* set point (% or g/h), boost, cover, reduction    [writable]
  ├─ setpoint.*     redox, pH                                        [writable]
  ├─ relay.*        AUX 1–4 on/off, mode, schedule, output active    [writable]
  ├─ light.*        on/off, mode off/on/auto, schedule               [writable]
  ├─ button.*       syncTime, ledNext                                [writable]
  ├─ modules.*      available modules
  ├─ info.*         online, offlineSince, lastUpdate, pendingCommands, lastCommand,
  │                 lastCommandStatus, clockDrift, lastClockSync, firmware, RSSI
  └─ raw.*          all raw fields (optional, read only)
```

`filtration.mode`: 0 = manual, 1 = auto, 2 = heat, 3 = smart, 4 = intel. `relay.auxNMode`: 0 = manual, 1 = auto, 2 = tempo, 3 = linked, 4 = linked_auto. You can write the number or the name.

`info.lastCommandStatus`: `sent`, `confirmed`, `retrying`, `expired` (dropped after the configured time), `failed` (not taken after two retries), `sent, not tracked` (ignored by the controller in its current mode, or clock sync), `error`.

Example: notify when a command could not be delivered

```js
on({ id: 'vistapool.0.*.info.lastCommandStatus', change: 'ne' }, obj => {
    if (['expired', 'failed', 'error'].includes(obj.state.val)) {
        const cmd = getState(obj.id.replace('lastCommandStatus', 'lastCommand')).val;
        sendTo('telegram.0', `Pool command not delivered: ${cmd} (${obj.state.val})`);
    }
});
```

## Notes

- **Wi-Fi:** many pool controllers sit at the edge of the Wi-Fi. While the controller is offline, commands cannot reach it; they are repeated when it is back (see above). Watch `info.online` and `info.offlineSince`.
- **Clock and time zone:** the clock sync uses the time zone of the ioBroker host. If ioBroker runs in UTC (e.g. Docker without `TZ`), enter the time zone of the pool (e.g. `Europe/Berlin`) in the instance settings, otherwise the automatic sync stays off.
- **Load on the cloud:** please do not lower the poll interval without need. With push, the adapter reads only every 15 minutes as a safety net.
- **Relay names** cannot be cleared – the controller ignores empty names. **LED:** only "next colour", no direct colour selection.
- Commands waiting for confirmation are lost when the adapter restarts.

## Help with other controllers

Controllers differ (variable speed pumps, g/h electrolysis, pH base, chlorine/conductivity probes, backwash, UV, ionisation, several pools per account). If something is missing or wrong:

1. Enable "Mirror raw fields" in the instance settings, or run the read-only [discovery script](tools/discovery/README.md) (it removes e-mail addresses, tokens and IDs).
2. Open an [issue](https://github.com/RePa02/ioBroker.vistapool/issues) with the controller model, what you expected, the debug log lines with `sendPoolCommand` and the anonymised discovery output.

## Technical details

- Sign-in: Firebase Identity Toolkit (e-mail/password), automatic token refresh
- Push: Firestore `Listen` stream via gRPC (same as the web app's `onSnapshot`), renewed every 45 minutes, resume token, exponential back-off; polling as fallback
- Read: Firestore REST (`users/{uid}`, `pools/{poolId}`)
- Write: Cloud Function `sendPoolCommand` (operation `WRP`, always the complete settings branch)
- Dependencies: `@iobroker/adapter-core`, `@grpc/grpc-js`, `@grpc/proto-loader`
- Tests: `npm test` (offline tests with an anonymised real pool document, local gRPC server for push, package checks), `npm run test:integration`
- Instance page: generated with `npm run build:config` from `tools/build-jsonconfig.js`

## Disclaimer

This is not an official product of Hayward or Sugar Valley. The cloud interface is not officially documented and may change or be restricted at any time. Use at your own risk; do not leave the filtration off during frost.

Hayward, AquaRite, Vistapool, Sugar Valley, Kripsol and Dagen are trademarks of their respective owners. They are only used to describe compatible devices.

## Credits

- **Development:** René Paul ([@RePa02](https://github.com/RePa02))
- **AI assistance:** protocol analysis, code, tests and documentation were created in collaboration with [Claude](https://www.anthropic.com/claude) (Anthropic). Commits with AI contribution carry `Co-Authored-By: Claude`.
- **Protocol knowledge:**
  - [aioaquarite](https://github.com/fdebrus/aioaquarite) by fdebrus (MIT) – sign-in, data model and command structure
  - Home Assistant integration [vistapool](https://www.home-assistant.io/integrations/vistapool) (Apache-2.0) – feature set and entities
  - Settings dialogs of the Vistapool web app – only the meaning of the fields was derived, no code was taken
  - `lib/proto/listen.proto`: subset of the Cloud Firestore API definitions by Google LLC (Apache-2.0)
- **Inspiration:** [ioBroker adapter request #717](https://github.com/ioBroker/AdapterRequests/issues/717) and everybody who tested and contributed information there

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### 0.3.1 (2026-11-12)
- (RePa02) Fix: pump mode "manual" and pump on/off written together are sent as one tracked command (the mode check used the old mode)

### 0.3.0 (2026-11-12)
- (RePa02) Push updates via the Firestore listen stream instead of polling; polling remains as fallback and safety net
- (RePa02) Writes within one second are merged into one command per branch; at most 6 commands per minute
- (RePa02) New status states per pool: offline since, pending commands, last command, its status and time, clock deviation, last clock sync
- (RePa02) Automatic clock sync on drift and after daylight saving time changes; configurable time zone
- (RePa02) Back-off on repeated cloud errors
- (RePa02) Hint when time windows are written in intel mode (the controller ignores them); writes to read-only states are reset
- (RePa02) English log messages; instance page answers in the system language; raw mirror is off by default for new instances
- (RePa02) Preparation for the ioBroker repository: ESLint, package and integration tests, GitHub Actions, release script

### 0.2.2 (2026-11-12)
- (RePa02) Unconfirmed commands expire after a configurable time (default 10 min) instead of switching late
- (RePa02) The current state is read right before every command, so changes made in the app are not overwritten
- (RePa02) Commands the controller ignores in its current mode are not repeated

### 0.2.1 (2026-11-12)
- (RePa02) Commands are checked for confirmation and repeated if the controller was offline
- (RePa02) At least 3 s between two commands; relay switches show the new state immediately; hints when switching in auto mode

### 0.2.0 (2026-11-10)
- (RePa02) Instance page with all settings of the Vistapool web app

### 0.1.0 (2026-11-10)
- (RePa02) Initial test release

## License

MIT License

Copyright (c) 2026 René Paul <github@news-flash.org>

See [LICENSE](LICENSE), including the notes on third-party sources.
