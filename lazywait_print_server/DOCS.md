# LazyWait Print Server

Runs the LazyWait Print Server on your Home Assistant box and connects the
branch to the LazyWait cloud. Installing this add-on also installs the
**LazyWait** Home Assistant integration automatically.

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
| `SUPABASE_URL` | yes | Your LazyWait Supabase project URL. |
| `SUPABASE_ANON_KEY` | yes | Supabase anon key (used for Realtime). |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase service-role key (backend use on the device). |
| `LAN_IP` | no | The branch device's LAN IP (e.g. `192.168.100.150`). Auto-detected if blank. |
| `LAZYWAIT_API_BASE` | no | Cloud API base. Defaults to `https://apiv2.lazywait.com/v1`. |
| `PORT` | no | Listen port (default 80). |
| `TZ` | no | Timezone (default `Asia/Riyadh`). |

## After install

1. **Start** the add-on (enable *Start on boot* and *Watchdog*).
2. **Restart Home Assistant** so it picks up the LazyWait integration the add-on
   just installed.
3. **Settings → Devices & Services → Add Integration → "LazyWait"**.
4. In the **LazyWait dashboard** → Integrations → Home Assistant → **Connect**,
   copy the **pairing code** and enter it in Home Assistant. The dashboard flips
   to **Connected**.

## Re-pairing

If you rotate or disconnect the connection from the dashboard, Home Assistant
prompts you to re-enter a fresh pairing code.

## Notes

- The add-on runs on the **host network** so it can reach LAN printers and be
  reached by POS devices.
- It pulls a **prebuilt image** — no on-device build, fast install.
