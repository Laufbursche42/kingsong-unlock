# Laufbursche KINGSONG unlock

A static web page that talks to KingSong electric unicycles (EUC) over Web Bluetooth. Connect, watch the raw frames the wheel sends and - straight from the browser - set the maximum speed, toggle the electronic lock, switch the display unit and change the headlight and pedal mode. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** or **Edge** on Android or desktop.

> **This is a feasibility study - the writes are sent, their effect on hardware is unconfirmed, and telemetry is shown raw only.** It exists to show what KingSong's Bluetooth protocol makes possible, not to be a finished product; the protocol was reconstructed from the official app (`com.kingsong.dlc`). The outbound frame format is code-proven (fixed 20 bytes, `AA 55` header, opcode at byte 16, `5A 5A` footer), as are the command opcodes the page uses. **Reading is the honest gap:** the app's inbound telemetry decoder is a single method that could not be decompiled, so the byte offsets that turn a received frame into speed, battery or voltage are not known - this page lists received frames as raw hex by opcode and does not invent decoded values. On writes, KingSong's effective command auth is server-driven (the app replays an init command set fetched from its backend) plus an optional car-password gate; this tool performs neither, so the firmware may ignore a write until that handshake is satisfied. Whether a max-speed value is accepted, and in what scaling, sits in the controller and must be tested on the wheel. Error-free operation is not promised and there is no warranty of any kind. Whatever you do with it, you do at your own risk - read the [Legal](#legal) section before you connect a wheel.

**Open the web app: [laufbursche42.github.io/kingsong-unlock](https://laufbursche42.github.io/kingsong-unlock/)**

Or run it yourself, no build step and no dependencies: clone the repo and serve the folder over a local HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/kingsong-unlock.git
cd kingsong-unlock
python -m http.server 8000
```

Any static server works. With Node installed, this does the same job:

```
npx serve .
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from connecting to the first send.

## What it does

- **Received data** - every frame the wheel sends, grouped by opcode and shown as raw hex. No named tiles, because the telemetry decoder is not reverse-engineerable from the app (see the verdict above).
- **Speed** - a max-speed set (opcode `0x87`, byte 4) plus a km/h <-> mph unit switch (`0x8A` / `0x8B`). The weak-magnetic overclock lives on the same `0x87` path.
- **Electronic lock** - lock and unlock the wheel via the stop-switch opcode `0x7E`.
- **More settings** - headlight (`0x6C`) and pedal mode (`0x1B`).
- **Expert** - send a raw frame verbatim, or build one from an opcode plus payload (the `AA 55` header, length and `5A 5A` footer are added for you).
- **Shortcut** - a home-screen link that locks or unlocks in a single tap.

## Protocol (proven)

- Primary GATT service `0xFFE0`, single characteristic `0xFFE1` (write without response + notify via CCCD `0x2902`). Alternate transport `0xAD00` with `0xAD01` write / `0xAD02` notify; the connect probe tries both. No BLE pairing or bonding crypto.
- Frame: fixed 20 bytes, `AA 55 | payload[2..15] | opcode@16 | sublen@17 | 5A 5A`. The documented control family carries the `5A 5A` footer and no CRC; a separate CRC-CCITT family exists for other opcodes and is out of scope here.
- TX opcodes used: `0x87` max-speed / weak-magnetic, `0x8A` / `0x8B` max speed + unit, `0x7E` electronic lock, `0x6C` headlight, `0x1B` pedal mode. The full catalog (`0x44` car-password, `0x85` speed alarms, voice, light modes, queries) is documented in the research report.

## Honesty

Device-untested by design - you test on your own wheel, which is exactly the point of a public tool. An echo in the log means the wheel **accepted** the frame; because this page cannot decode telemetry, only the wheel's real behaviour proves a write took effect. Inbound telemetry is deliberately not decoded rather than guessed: the research marked it a device-side unknown and this page keeps it that way.

## Legal

License: PolyForm Noncommercial, see [License](LICENSE.md). Privacy: nothing leaves your device, see [Privacy](PRIVACY.md). Trademarks: KINGSONG is a trademark of its respective owner, this project is independent, see [Trademarks](TRADEMARKS.md).

Source: https://github.com/Laufbursche42/kingsong-unlock
