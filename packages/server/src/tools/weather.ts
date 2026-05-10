// packages/server/src/tools/weather.ts

interface WttrCondition {
  temp_C: string
  FeelsLikeC: string
  humidity: string
  windspeedKmph: string
  weatherDesc: { value: string }[]
  lang_zh?: { value: string }[]
}

interface WttrResponse {
  current_condition: WttrCondition[]
}

export async function getWeather(city: string): Promise<string> {
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DocMind/1.0' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`天气 API 返回 ${res.status}`)

  const data = (await res.json()) as WttrResponse
  const c = data.current_condition[0]
  const desc = c.lang_zh?.[0]?.value ?? c.weatherDesc[0].value

  return `${city}当前天气：${desc}，气温 ${c.temp_C}°C（体感 ${c.FeelsLikeC}°C），湿度 ${c.humidity}%，风速 ${c.windspeedKmph} km/h`
}
