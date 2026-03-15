export default {
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/api/dart/list") {
      const company = url.searchParams.get("name") || ""
      const start = url.searchParams.get("start") || ""
      const end = url.searchParams.get("end") || ""

      const apiKey = DART_API_KEY

      const apiUrl = new URL("https://opendart.fss.or.kr/api/list.json")
      apiUrl.searchParams.set("crtfc_key", apiKey)

      if (company) apiUrl.searchParams.set("corp_name", company)
      if (start) apiUrl.searchParams.set("bgn_de", start)
      if (end) apiUrl.searchParams.set("end_de", end)

      apiUrl.searchParams.set("page_no", "1")
      apiUrl.searchParams.set("page_count", "100")

      const res = await fetch(apiUrl)
      const data = await res.json()

      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      })
    }

    return new Response("ipr dashboard worker running")
  }
}
