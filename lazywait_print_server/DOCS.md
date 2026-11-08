# LazyWait Print Server

Runs the LazyWait Print Server on the branch's Home Assistant box and connects
the branch to the LazyWait cloud. Installing this add-on also installs the
**LazyWait** Home Assistant integration, which brings the branch's devices,
sensors, live cameras and Loss Prevention to the LazyWait dashboard and the
LazyWait Admin app.

## Install and pair

1. **Start** the add-on and turn on *Start on boot* and *Watchdog*.
2. **Restart Home Assistant** (Settings → System → power icon → Restart Home
   Assistant) so it loads the LazyWait integration the add-on just installed.
3. **Settings → Devices & services → Add integration → "LazyWait"**.
4. In the LazyWait dashboard, open **Integrations → Home Assistant → Connect**,
   copy the **pairing code** and enter it in Home Assistant. The dashboard
   changes to **Connected**.

You never enter LazyWait keys here: the device receives what it needs when you
pair it.

If you rotate or disconnect the connection from the dashboard, Home Assistant
asks for a fresh pairing code.

## Updating

Home Assistant only checks for new versions every few hours. To update now:

1. **Settings → Apps → App store**, then **⋮ (top right) → Check for updates**.
2. Open **LazyWait Print Server** and click **Update**.
3. **Restart Home Assistant** after every update. The add-on copies the newest
   LazyWait integration into Home Assistant, but Home Assistant only loads it
   on a restart. Until then the store keeps running the old integration: the
   LazyWait Admin app's camera screen shows the version it is running under
   **Details**.

## Options

Set these on the **Configuration** tab, then restart the add-on. Options marked
*hidden* only appear after you turn on **Show unused optional configuration
options**.

| Option | Default | What it does |
|--------|---------|--------------|
| `TZ` | `Asia/Riyadh` | The branch's time zone. |
| `PORT` | `80` | The port the print server listens on. |
| `LAN_IP` | auto | The box's LAN address, e.g. `192.168.100.150`. Leave blank to detect it. |
| `LAZYWAIT_API_BASE` | `https://apiv2.lazywait.com/v1` | The LazyWait cloud. Change it only when LazyWait support asks you to. |
| `listen_orders`, `listen_openings`, `listen_closings` | on | Automatic printing for new orders, cashier openings and cashier closings. Turn one off if the branch doesn't use it. |
| `enable_camera_ai` | on | Allows camera AI to start. It stays idle until camera AI is turned on in the print server's Features page. Set it off to make sure detection never runs on this box. |
| `enable_live_webrtc` | on | Live camera video straight from this box to the LazyWait apps. See *Live camera view*. |
| `enable_loss_prevention` | off | The Loss Prevention device. See *Loss Prevention*. |
| `ha_token` | *hidden* | A long-lived access token of a Home Assistant **admin** user. Loss Prevention needs it. |
| `ha_url` | *hidden* | Only if Home Assistant is not on this box. Default `http://127.0.0.1:8123`. |
| `isapi_username`, `isapi_password` | empty | The camera recorder (NVR) account Loss Prevention uses for evidence snapshots and clips. It stays on this box and is never sent to LazyWait. |
| `lp_agent_port` | `8095` | A local port Loss Prevention uses on this box. Change it only if 8095 is taken. |
| `admin_password` | *hidden* | Replaces the device's factory admin password. See *Security*. |

## Live camera view

The LazyWait Admin app and the dashboard play a branch camera in one of two ways:

- **Direct**: the video goes from this box straight to the phone, through a
  secure relay when the two can't reach each other. Nothing passes through the
  LazyWait servers. This needs `enable_live_webrtc` on.
- **Relay**: when direct isn't possible, this box sends the camera to the
  LazyWait media server, which passes it on.

Each phone that watches uses some of the branch's upload speed: about
0.5 Mbps in normal quality and 2–4 Mbps in HD. A camera can be watched by up to
3 people at once, and a branch by up to 6.

### Set up the cameras for phones

Phones can only play **H.264** live video. Many recorders send **H.265** (also
called HEVC or H.265+). For each camera, on the recorder's web page:

1. **Configuration → Video/Audio → Video**, choose the camera.
2. **Stream type: Sub-stream**, **Video encoding: H.264**, 640×360 or
   704×576, 10–15 frames per second. Turn smart codec / H.265+ off.
3. **Save**, then **Copy to…** all channels.

The **main stream can stay H.265**, so recordings keep their storage savings.
Live view uses the sub-stream by default and the main stream only for **HD**.

If a camera still sends H.265, the add-on converts it to H.264 on this box
(add-on 26.11.8 or later, after a Home Assistant restart). Converting costs a
lot of processor time on a Raspberry Pi, so the box converts at most two
normal-quality views, or one HD view, at a time. Beyond that the app shows the
camera's latest picture instead of video. Setting the sub-stream to H.264 is
always the better fix: it starts faster and costs nothing.

### When live video doesn't play

The app shows the latest picture with **"Live video couldn't connect"**, a
reason, and a **Details** line for support.

| What you see | What it means | What to do |
|---|---|---|
| "…needs a restart to load the latest LazyWait integration" | The add-on was updated but Home Assistant wasn't restarted. | Restart Home Assistant. |
| "This branch runs LazyWait integration 26.11.x…" | The integration is too old to play these cameras. | Update the add-on (see *Updating*), then restart Home Assistant. |
| "…the camera's video format may not play on phones" | The camera sends H.265. | Set its sub-stream to H.264 (above). |
| "The store's Home Assistant isn't connected" | The box is off, offline, or not paired. | Check power and internet, then the integration in Home Assistant. |
| Details: `Direct HA_WEBRTC_STREAM_FAILED`, `Player WHEP_400` | The box could not produce a stream a phone can play, usually H.265. | As above. |
| Details: `… v26.11.x` at the end of the Branch line | The integration version this branch runs. | Compare with the add-on version. |

To see the exact reason on the box: **Settings → System → Logs**, search
`lazywait`. A line like `refused: stream_failed (go2rtc: streams: codecs not
matched: video:H265 …)` means the camera sends H.265.

## Loss Prevention

Loss Prevention watches the branch's Home Assistant signals (shutter, door,
lock, alarm, lights, motion, cash drawer) and its cameras on this box, and
sends signed results to LazyWait. Video stays in the store. It needs a Loss
Prevention licence on the branch, and is **off** until you turn it on here.

### Turn it on

1. In Home Assistant, open your profile → **Security → Long-lived access
   tokens → Create token**. Use an **admin** user and copy the token.
2. In this add-on's **Configuration** tab, turn on **Show unused optional
   configuration options**, then set:
   - `enable_loss_prevention`: on
   - `ha_token`: the token from step 1
   - `isapi_username` / `isapi_password`: the recorder (NVR) account, for
     evidence snapshots and clips (optional)
3. **Save** and **restart the add-on**. The device registers with LazyWait by
   itself within a minute.
4. In the LazyWait dashboard, open **Loss Prevention**: the branch's device
   shows as online. Then map the branch's signals and draw the camera zones
   (**Loss Prevention → Cameras → Edit zones**).

### "The edge device … has never synced"

This incident means Loss Prevention has never been turned on for that branch's
box: follow *Turn it on* above. If the device synced before and then stopped,
the incident instead says how many minutes it has been silent. Check that the
box has power and internet, and look at this add-on's **Log** tab.

### Recording employees from cameras

- **Today**, check-ins from cameras are recorded while the dashboard's
  **AI Cameras** page is open on the camera that sees the entrance: the page
  spots the faces and LazyWait identifies and records them. When nobody has
  that page open, nobody is recorded from the camera.
- **On the box, without a page open**, face check-ins are part of Loss
  Prevention. LazyWait turns this on for your account once it is approved for
  your country. It also needs Loss Prevention turned on here, the employees'
  faces enrolled, and the entrance camera marked as an entrance.

### Hardware

- A **Raspberry Pi 5 with 8 GB** (or a small Intel/AMD mini PC), the official
  cooler and 27 W power supply, a **USB 3 SSD** instead of an SD card, and a
  small UPS. Loss Prevention keeps its data on this box.
- A Pi 5 analyses about **3–4 cameras** on its own. More cameras need an
  AI HAT+ or a second box. Cameras you only watch live cost almost nothing.
- Loss Prevention doesn't run on 32-bit (armv7) systems.

## Security

Every device starts with the same factory admin password, and the add-on logs a
security warning on each start until you change it. Set `admin_password`
(8 characters or more) and restart the add-on: the device's local `admin`
account switches to it and every admin session is signed out. **Update every
till in the branch first**: tills on older LazyWait POS versions still use the
factory password and stop printing through this box until they're updated.

## Notes

- The add-on runs on the **host network**, so it can reach the branch's
  printers and the tills can reach it.
- It installs a **prebuilt image**, so there's no build on the box.
