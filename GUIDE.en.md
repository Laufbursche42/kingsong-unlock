# Guide

> **Important for error reports:** switch on the **Diagnostic log** at the bottom of the page *before* you connect to the scooter. Only then is the full connection handshake captured - and those are exactly the lines we need in a [ticket](https://github.com/Laufbursche42/Laufbursche42/issues) to reproduce a problem.

## What you need
- A KingSong electric unicycle (EUC).
- A phone or computer with **Chrome**, **Edge**, or on iOS **Bluefy**. Safari and Firefox cannot do Web Bluetooth.

## Connecting
1. Turn on Bluetooth and wake the wheel.
2. Tap **Connect** and pick the wheel from the list.
3. If it is not listed, tick **Show all devices** and try again. The real check is the Bluetooth service found (FFE0 or AD00), not the advertised name.
4. Once connected, the received-data, lock, speed and settings cards appear.

## Reading received data
The wheel streams frames continuously. The byte offsets in the telemetry frame are not broken out into named values such as speed or battery, so the **Received data** card shows each frame as raw hex per opcode. Nothing here is guessed.

## Setting the speed
- **Set** writes the max-speed value from the field as opcode 0x87 (byte 4). That is also the weak-magnetic overclock path.
- The **km/h** and **mph** buttons switch the unit (opcode 0x8B and 0x8A) and carry the same value along.
- Important: an echo in the log only means the wheel accepted the frame. Whether the firmware really takes the value, and in what scaling, you must test on your own device. Reading the current limit back is not possible without telemetry.

## Electronic lock
In the **Electronic lock** card you toggle the wheel's stop-switch (opcode 0x7E). Whether that is a true anti-theft lock or only a ride-stop depends on the model. Unlock releases it again.

## More settings
Headlight (0x6C) and pedal mode (0x1B). The rows are visible once you are connected, because their current values cannot be read back.

## Advanced settings (engine level)
**Send a raw frame** sends your hex bytes unchanged. **Build a frame** takes an opcode and payload and adds the header (AA 55), length and footer (5A 5A) for you.

## Shortcuts
Copy the link to your home screen, then one tap unlocks or locks directly. On iOS via Bluefy, and the wheel must have been connected normally once before.

## If something does not work
- Cannot connect? Check that the browser supports Web Bluetooth, Bluetooth is on and the wheel is awake. Retry with **Show all devices**.
- Nothing happens after a command? Check the log: if it says "sent" but no "confirmed", the wheel did not acknowledge the frame. Note that KingSong fetches its init commands from a server; without that handshake the firmware may ignore a write.
- **Diagnostics: list all devices** in the log area shows every Bluetooth service of a device without writing anything - useful for support.

## Contribute
Want to find out if and how tuning works on your scooter? Test this tool on your own vehicle and open a ticket on [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - with your model and what worked (or did not). That way we figure out together what is possible on which model.
