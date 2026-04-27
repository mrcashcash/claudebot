---
name: tel-aviv-weather
description: Fetch today's weather forecast for Tel Aviv from the free Open-Meteo API. Use when the user asks for the Tel Aviv weather, a daily forecast, or when running the scheduled morning weather report.
---

# Tel Aviv Weather

Fetches today's forecast for Tel Aviv (lat 32.0853, lon 34.7818) from [Open-Meteo](https://open-meteo.com) — free, no API key, no auth.

## How to use

Call the endpoint below with `WebFetch`. It returns JSON with daily summary + hourly precipitation so you can also report *when* it will rain.

```
https://api.open-meteo.com/v1/forecast?latitude=32.0853&longitude=34.7818&timezone=Asia/Jerusalem&forecast_days=1&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunshine_duration,weather_code&hourly=precipitation,precipitation_probability,weather_code
```

Pass it to `WebFetch` with a prompt like: *"Return the raw JSON unchanged."* Then parse the JSON yourself.

## Fields you'll get

**`daily`** (1-element arrays for today):
- `temperature_2m_max` / `temperature_2m_min` — °C
- `precipitation_sum` — mm of rain expected over the day
- `precipitation_probability_max` — % chance of rain (peak)
- `sunshine_duration` — seconds of sun (divide by 3600 for hours)
- `weather_code` — WMO code (see table below)

**`hourly`** (24-element arrays, one per hour starting at 00:00 local):
- `time[]` — ISO timestamps in Asia/Jerusalem
- `precipitation[]` — mm in that hour
- `precipitation_probability[]` — % per hour
- `weather_code[]` — WMO code per hour

To answer *"what time will it rain?"*, scan `hourly.precipitation_probability` for entries ≥ 50% (or `hourly.precipitation` > 0) and report the matching `hourly.time`.

## WMO weather codes (the ones that matter)

| Code | Meaning |
|---|---|
| 0 | Clear sky |
| 1–3 | Mainly clear / partly cloudy / overcast |
| 45, 48 | Fog |
| 51, 53, 55 | Drizzle (light → dense) |
| 61, 63, 65 | Rain (slight → heavy) |
| 71, 73, 75 | Snow |
| 80, 81, 82 | Rain showers |
| 95 | Thunderstorm |
| 96, 99 | Thunderstorm with hail |

## Output format for the daily morning report (Hebrew)

The 8 AM Telegram report must be **in Hebrew**. Use this layout. Drop the rain line on dry days.

```
☀️ תל אביב — <יום בשבוע>, <dd ב<חודש>>
🌡 <min>°–<max>°C   <תיאור מזג האוויר>
☔ <prob>% סיכוי לגשם · <sum> מ"מ סה"כ
🕐 שעות גשם צפויות: <HH:MM>–<HH:MM>
🌞 <שעות שמש> שעות שמש
```

### Hebrew vocabulary

**Days of the week** (`יום ראשון`, `יום שני`, `יום שלישי`, `יום רביעי`, `יום חמישי`, `יום שישי`, `שבת`).

**Months** (genitive form, prefixed with ב):
| EN | HE |
|---|---|
| Jan | בינואר |
| Feb | בפברואר |
| Mar | במרץ |
| Apr | באפריל |
| May | במאי |
| Jun | ביוני |
| Jul | ביולי |
| Aug | באוגוסט |
| Sep | בספטמבר |
| Oct | באוקטובר |
| Nov | בנובמבר |
| Dec | בדצמבר |

**Weather descriptions** (map from WMO `weather_code`):
| Code | Hebrew |
|---|---|
| 0 | שמיים בהירים |
| 1 | בהיר ברובו |
| 2 | מעונן חלקית |
| 3 | מעונן |
| 45, 48 | ערפל |
| 51, 53, 55 | טפטוף |
| 61 | גשם קל |
| 63 | גשם |
| 65 | גשם כבד |
| 71, 73, 75 | שלג |
| 80, 81, 82 | ממטרים |
| 95 | סופת רעמים |
| 96, 99 | סופת רעמים עם ברד |

Keep it terse — a glanceable morning briefing, not a paragraph. Numbers stay in Western digits; punctuation should match the Hebrew layout (e.g. `מ"מ` with quotes, not `mm`).

## Notes

- No API key. No rate-limit concerns for once-a-day use.
- Times are already in Asia/Jerusalem because of `timezone=Asia/Jerusalem`.
- If `WebFetch` is denied (cron fire without an always-allow rule), the report can't run — approve `WebFetch` as **Always** once interactively first, or add it via `/rules`.
