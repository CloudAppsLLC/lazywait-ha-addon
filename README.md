# LazyWait Add-ons for Home Assistant

A public Home Assistant **add-on repository** for the **LazyWait Print Server**.
Add this repository to your Home Assistant, install the add-on, and you get
local printing for a LazyWait branch **plus** the LazyWait integration —
installed automatically, no terminal, no file copying.

> The add-on runs a **prebuilt image** pulled from a public registry. LazyWait's
> source code stays private; only the built image is published.

## Install (one click)

1. Open this link on (or from a device that can reach) your Home Assistant:

   **[Add the LazyWait repository to Home Assistant](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FCloudAppsLLC%2Flazywait-ha-addon)**

   Home Assistant opens with the repository URL pre-filled → click **Add**.

   *Manual fallback:* Settings → Add-ons → Add-on Store → ⋮ → **Repositories** →
   paste `https://github.com/CloudAppsLLC/lazywait-ha-addon` → **Add**.

2. In the **Add-on Store**, open **LazyWait Print Server** → **Install**.
3. On **Configuration**, set your `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (and optional `LAN_IP`), then **Start**.
4. The add-on installs the **LazyWait** integration. **Restart Home Assistant**,
   then Settings → Devices & Services → **Add Integration → "LazyWait"** and
   enter the pairing code from your **LazyWait dashboard**
   (Integrations → Home Assistant → Connect).

## Architectures

`aarch64` (Raspberry Pi 4/5, most HA OS boxes), `armv7`, `amd64`.

## Support

Issues: https://github.com/CloudAppsLLC/lazywait-ha-addon/issues
