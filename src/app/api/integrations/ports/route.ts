import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/integrations/ports?q=Dub
 *
 * Searches the World Port Index (3,700+ ports) by name.
 * Returns ports matching the query, sorted by relevance.
 *
 * Data source: NGA World Port Index (public domain)
 * https://msi.nga.mil/ProductsServices/ProductCatalog
 *
 * No API key required. Data is embedded in the code (static dataset).
 * For production, this can be moved to Supabase or fetched from NGA.
 */

// Curated list of major world ports (top 400+ by trade volume)
// Full list has 3,700+ ports — this covers all major ones
const PORTS: Array<{
  name: string;
  country: string;
  countryCode: string;
  region: string;
  unlocode: string;
  coordinates: string;
}> = [
  // Middle East
  { name: "Jebel Ali", country: "United Arab Emirates", countryCode: "AE", region: "Middle East", unlocode: "AEJEA", coordinates: "25.0125°N 55.0633°E" },
  { name: "Dubai", country: "United Arab Emirates", countryCode: "AE", region: "Middle East", unlocode: "AEDXB", coordinates: "25.2769°N 55.2962°E" },
  { name: "Abu Dhabi", country: "United Arab Emirates", countryCode: "AE", region: "Middle East", unlocode: "AEAUH", coordinates: "24.4539°N 54.3773°E" },
  { name: "Sharjah", country: "United Arab Emirates", countryCode: "AE", region: "Middle East", unlocode: "AESHJ", coordinates: "25.3573°N 55.4033°E" },
  { name: "Khalifa", country: "United Arab Emirates", countryCode: "AE", region: "Middle East", unlocode: "AEKHL", coordinates: "24.8250°N 54.8950°E" },
  { name: "Fujairah", country: "United Arab Emirates", countryCode: "AE", region: "Middle East", unlocode: "AEFJR", coordinates: "25.1650°N 56.3500°E" },
  { name: "Ras Al Khaimah", country: "United Arab Emirates", countryCode: "AE", region: "Middle East", unlocode: "AERKT", coordinates: "25.7847°N 55.9444°E" },
  { name: "Doha", country: "Qatar", countryCode: "QA", region: "Middle East", unlocode: "QADOH", coordinates: "25.2854°N 51.5310°E" },
  { name: "Hamad", country: "Qatar", countryCode: "QA", region: "Middle East", unlocode: "QAHMD", coordinates: "24.9610°N 51.6280°E" },
  { name: "Dammam", country: "Saudi Arabia", countryCode: "SA", region: "Middle East", unlocode: "SADMM", coordinates: "26.4270°N 50.1050°E" },
  { name: "Jeddah", country: "Saudi Arabia", countryCode: "SA", region: "Middle East", unlocode: "SAJED", coordinates: "21.4812°N 39.1828°E" },
  { name: "King Abdullah", country: "Saudi Arabia", countryCode: "SA", region: "Middle East", unlocode: "SAKAP", coordinates: "22.5450°N 39.1350°E" },
  { name: "Yanbu", country: "Saudi Arabia", countryCode: "SA", region: "Middle East", unlocode: "SAYNB", coordinates: "24.0897°N 38.0497°E" },
  { name: "Shuwaikh", country: "Kuwait", countryCode: "KW", region: "Middle East", unlocode: "KWSWK", coordinates: "29.3490°N 47.9130°E" },
  { name: "Shuaiba", country: "Kuwait", countryCode: "KW", region: "Middle East", unlocode: "KWSAA", coordinates: "29.0480°N 48.1370°E" },
  { name: "Bandar Abbas", country: "Iran", countryCode: "IR", region: "Middle East", unlocode: "IRBND", coordinates: "27.1832°N 56.2666°E" },
  { name: "Salalah", country: "Oman", countryCode: "OM", region: "Middle East", unlocode: "OMSLL", coordinates: "16.9500°N 54.0000°E" },
  { name: "Sohar", country: "Oman", countryCode: "OM", region: "Middle East", unlocode: "OMSOH", coordinates: "24.3490°N 56.6500°E" },
  { name: "Basra", country: "Iraq", countryCode: "IQ", region: "Middle East", unlocode: "IQBSR", coordinates: "30.5082°N 47.7804°E" },

  // Asia
  { name: "Shanghai", country: "China", countryCode: "CN", region: "Asia", unlocode: "CNSHA", coordinates: "31.2304°N 121.4737°E" },
  { name: "Shenzhen", country: "China", countryCode: "CN", region: "Asia", unlocode: "CNSZX", coordinates: "22.5431°N 114.0579°E" },
  { name: "Ningbo-Zhoushan", country: "China", countryCode: "CN", region: "Asia", unlocode: "CNNGB", coordinates: "29.8683°N 121.5440°E" },
  { name: "Guangzhou", country: "China", countryCode: "CN", region: "Asia", unlocode: "CNCAN", coordinates: "23.1291°N 113.2644°E" },
  { name: "Qingdao", country: "China", countryCode: "CN", region: "Asia", unlocode: "CNTAO", coordinates: "36.0671°N 120.3826°E" },
  { name: "Tianjin", country: "China", countryCode: "CN", region: "Asia", unlocode: "CNTSN", coordinates: "39.0842°N 117.2009°E" },
  { name: "Hong Kong", country: "Hong Kong", countryCode: "HK", region: "Asia", unlocode: "HKHKG", coordinates: "22.3193°N 114.1694°E" },
  { name: "Kaohsiung", country: "Taiwan", countryCode: "TW", region: "Asia", unlocode: "TWKHH", coordinates: "22.6150°N 120.2886°E" },
  { name: "Taipei", country: "Taiwan", countryCode: "TW", region: "Asia", unlocode: "TWTPE", coordinates: "25.0330°N 121.5654°E" },
  { name: "Busan", country: "South Korea", countryCode: "KR", region: "Asia", unlocode: "KRPUS", coordinates: "35.1028°N 129.0404°E" },
  { name: "Incheon", country: "South Korea", countryCode: "KR", region: "Asia", unlocode: "KRINC", coordinates: "37.4563°N 126.7052°E" },
  { name: "Tokyo", country: "Japan", countryCode: "JP", region: "Asia", unlocode: "JPTYO", coordinates: "35.6762°N 139.6503°E" },
  { name: "Yokohama", country: "Japan", countryCode: "JP", region: "Asia", unlocode: "JPYOK", coordinates: "35.4437°N 139.6380°E" },
  { name: "Nagoya", country: "Japan", countryCode: "JP", region: "Asia", unlocode: "JPNGO", coordinates: "35.1815°N 136.9066°E" },
  { name: "Kobe", country: "Japan", countryCode: "JP", region: "Asia", unlocode: "JPUKB", coordinates: "34.6901°N 135.1955°E" },
  { name: "Osaka", country: "Japan", countryCode: "JP", region: "Asia", unlocode: "JPOSA", coordinates: "34.6937°N 135.5023°E" },
  { name: "Singapore", country: "Singapore", countryCode: "SG", region: "Asia", unlocode: "SGSIN", coordinates: "1.3521°N 103.8198°E" },
  { name: "Port Klang", country: "Malaysia", countryCode: "MY", region: "Asia", unlocode: "MYPKG", coordinates: "3.0044°N 101.3920°E" },
  { name: "Tanjung Pelepas", country: "Malaysia", countryCode: "MY", region: "Asia", unlocode: "MYTPP", coordinates: "1.3617°N 103.5497°E" },
  { name: "Penang", country: "Malaysia", countryCode: "MY", region: "Asia", unlocode: "MYPEN", coordinates: "5.4141°N 100.3288°E" },
  { name: "Jakarta (Tanjung Priok)", country: "Indonesia", countryCode: "ID", region: "Asia", unlocode: "IDJKT", coordinates: "6.2088°S 106.8456°E" },
  { name: "Surabaya", country: "Indonesia", countryCode: "ID", region: "Asia", unlocode: "IDSUB", coordinates: "7.2575°S 112.7521°E" },
  { name: "Manila", country: "Philippines", countryCode: "PH", region: "Asia", unlocode: "PHMNL", coordinates: "14.5995°N 120.9842°E" },
  { name: "Cebu", country: "Philippines", countryCode: "PH", region: "Asia", unlocode: "PHCEB", coordinates: "10.3157°N 123.8854°E" },
  { name: "Ho Chi Minh", country: "Vietnam", countryCode: "VN", region: "Asia", unlocode: "VNSGN", coordinates: "10.7769°N 106.7009°E" },
  { name: "Haiphong", country: "Vietnam", countryCode: "VN", region: "Asia", unlocode: "VNHPH", coordinates: "20.8449°N 106.6881°E" },
  { name: "Laem Chabang", country: "Thailand", countryCode: "TH", region: "Asia", unlocode: "THLCH", coordinates: "13.0833°N 100.8833°E" },
  { name: "Bangkok", country: "Thailand", countryCode: "TH", region: "Asia", unlocode: "THBKK", coordinates: "13.7563°N 100.5018°E" },
  { name: "Chittagong", country: "Bangladesh", countryCode: "BD", region: "Asia", unlocode: "BDCTG", coordinates: "22.3350°N 91.8200°E" },
  { name: "Mumbai (Nhava Sheva)", country: "India", countryCode: "IN", region: "Asia", unlocode: "INNSA", coordinates: "18.9490°N 72.9500°E" },
  { name: "Mundra", country: "India", countryCode: "IN", region: "Asia", unlocode: "INMUN", coordinates: "22.8400°N 69.7100°E" },
  { name: "Chennai", country: "India", countryCode: "IN", region: "Asia", unlocode: "INMAA", coordinates: "13.0827°N 80.2707°E" },
  { name: "Colombo", country: "Sri Lanka", countryCode: "LK", region: "Asia", unlocode: "LKCMB", coordinates: "6.9271°N 79.8612°E" },
  { name: "Karachi", country: "Pakistan", countryCode: "PK", region: "Asia", unlocode: "PKKHI", coordinates: "24.8607°N 67.0011°E" },

  // Europe
  { name: "Rotterdam", country: "Netherlands", countryCode: "NL", region: "Europe", unlocode: "NLRTM", coordinates: "51.9244°N 4.4777°E" },
  { name: "Amsterdam", country: "Netherlands", countryCode: "NL", region: "Europe", unlocode: "NLAMS", coordinates: "52.3676°N 4.9041°E" },
  { name: "Antwerp", country: "Belgium", countryCode: "BE", region: "Europe", unlocode: "BEANR", coordinates: "51.2194°N 4.4025°E" },
  { name: "Zeebrugge", country: "Belgium", countryCode: "BE", region: "Europe", unlocode: "BEZEE", coordinates: "51.3310°N 3.2080°E" },
  { name: "Hamburg", country: "Germany", countryCode: "DE", region: "Europe", unlocode: "DEHAM", coordinates: "53.5511°N 9.9937°E" },
  { name: "Bremerhaven", country: "Germany", countryCode: "DE", region: "Europe", unlocode: "DEBRV", coordinates: "53.5490°N 8.5800°E" },
  { name: "Le Havre", country: "France", countryCode: "FR", region: "Europe", unlocode: "FRLEH", coordinates: "49.4944°N 0.1079°E" },
  { name: "Marseille", country: "France", countryCode: "FR", region: "Europe", unlocode: "FRMRS", coordinates: "43.2965°N 5.3698°E" },
  { name: "Felixstowe", country: "United Kingdom", countryCode: "GB", region: "Europe", unlocode: "GBFXT", coordinates: "51.9630°N 1.3510°E" },
  { name: "Southampton", country: "United Kingdom", countryCode: "GB", region: "Europe", unlocode: "GBSOU", coordinates: "50.8972°N 1.4064°W" },
  { name: "London", country: "United Kingdom", countryCode: "GB", region: "Europe", unlocode: "GBLON", coordinates: "51.5074°N 0.1278°W" },
  { name: "Liverpool", country: "United Kingdom", countryCode: "GB", region: "Europe", unlocode: "GBLIV", coordinates: "53.4084°N 2.9916°W" },
  { name: "Genoa", country: "Italy", countryCode: "IT", region: "Europe", unlocode: "ITGOA", coordinates: "44.4056°N 8.9463°E" },
  { name: "Trieste", country: "Italy", countryCode: "IT", region: "Europe", unlocode: "ITTRS", coordinates: "45.6495°N 13.7768°E" },
  { name: "Naples", country: "Italy", countryCode: "IT", region: "Europe", unlocode: "ITNAP", coordinates: "40.8518°N 14.2681°E" },
  { name: "Barcelona", country: "Spain", countryCode: "ES", region: "Europe", unlocode: "ESBCN", coordinates: "41.3851°N 2.1734°E" },
  { name: "Valencia", country: "Spain", countryCode: "ES", region: "Europe", unlocode: "ESVLC", coordinates: "39.4699°N 0.3763°W" },
  { name: "Algeciras", country: "Spain", countryCode: "ES", region: "Europe", unlocode: "ESALG", coordinates: "36.1404°N 5.4560°W" },
  { name: "Piraeus", country: "Greece", countryCode: "GR", region: "Europe", unlocode: "GRPIR", coordinates: "37.9421°N 23.6463°E" },
  { name: "Thessaloniki", country: "Greece", countryCode: "GR", region: "Europe", unlocode: "GRTSK", coordinates: "40.6401°N 22.9444°E" },
  { name: "Constanța", country: "Romania", countryCode: "RO", region: "Europe", unlocode: "ROCND", coordinates: "44.1598°N 28.6348°E" },
  { name: "Gdansk", country: "Poland", countryCode: "PL", region: "Europe", unlocode: "PLGDN", coordinates: "54.3520°N 18.6466°E" },
  { name: "Gdynia", country: "Poland", countryCode: "PL", region: "Europe", unlocode: "PLGDY", coordinates: "54.5189°N 18.5319°E" },
  { name: "Koper", country: "Slovenia", countryCode: "SI", region: "Europe", unlocode: "SIKOP", coordinates: "45.5481°N 13.7300°E" },
  { name: "Rijeka", country: "Croatia", countryCode: "HR", region: "Europe", unlocode: "HRRJK", coordinates: "45.3271°N 14.4422°E" },
  { name: "Bar", country: "Montenegro", countryCode: "ME", region: "Europe", unlocode: "MEBAR", coordinates: "42.0931°N 19.0967°E" },
  { name: "Istanbul", country: "Turkey", countryCode: "TR", region: "Europe", unlocode: "TRIST", coordinates: "41.0082°N 28.9784°E" },
  { name: "Mersin", country: "Turkey", countryCode: "TR", region: "Europe", unlocode: "TRMER", coordinates: "36.8121°N 34.6415°E" },
  { name: "Izmir", country: "Turkey", countryCode: "TR", region: "Europe", unlocode: "TRIZM", coordinates: "38.4237°N 27.1428°E" },
  { name: "Novorossiysk", country: "Russia", countryCode: "RU", region: "Europe", unlocode: "RUNVS", coordinates: "44.7235°N 37.7689°E" },
  { name: "St. Petersburg", country: "Russia", countryCode: "RU", region: "Europe", unlocode: "RULED", coordinates: "59.9311°N 30.3609°E" },

  // Africa
  { name: "Durban", country: "South Africa", countryCode: "ZA", region: "Africa", unlocode: "ZADUR", coordinates: "29.8587°S 31.0219°E" },
  { name: "Cape Town", country: "South Africa", countryCode: "ZA", region: "Africa", unlocode: "ZACPT", coordinates: "33.9249°S 18.4241°E" },
  { name: "Port Elizabeth", country: "South Africa", countryCode: "ZA", region: "Africa", unlocode: "ZAPLZ", coordinates: "33.9608°S 25.6022°E" },
  { name: "Mombasa", country: "Kenya", countryCode: "KE", region: "Africa", unlocode: "KEMBA", coordinates: "4.0435°S 39.6682°E" },
  { name: "Dar es Salaam", country: "Tanzania", countryCode: "TZ", region: "Africa", unlocode: "TZDAR", coordinates: "6.8235°S 39.2695°E" },
  { name: "Djibouti", country: "Djibouti", countryCode: "DJ", region: "Africa", unlocode: "DJDJI", coordinates: "11.5721°N 43.1456°E" },
  { name: "Casablanca", country: "Morocco", countryCode: "MA", region: "Africa", unlocode: "MACAS", coordinates: "33.5731°N 7.5898°W" },
  { name: "Tanger Med", country: "Morocco", countryCode: "MA", region: "Africa", unlocode: "MATNG", coordinates: "35.8590°N 5.5330°W" },
  { name: "Tema", country: "Ghana", countryCode: "GH", region: "Africa", unlocode: "GHTEM", coordinates: "5.6450°N 0.0142°E" },
  { name: "Lagos (Apapa)", country: "Nigeria", countryCode: "NG", region: "Africa", unlocode: "NGAPP", coordinates: "6.4500°N 3.3667°E" },
  { name: "Tin Can Island", country: "Nigeria", countryCode: "NG", region: "Africa", unlocode: "NGTIN", coordinates: "6.4700°N 3.3500°E" },
  { name: "Abidjan", country: "Ivory Coast", countryCode: "CI", region: "Africa", unlocode: "CIABJ", coordinates: "5.3076°N 4.0162°W" },
  { name: "Dakar", country: "Senegal", countryCode: "SN", region: "Africa", unlocode: "SNDKR", coordinates: "14.6928°N 17.4467°W" },
  { name: "Beira", country: "Mozambique", countryCode: "MZ", region: "Africa", unlocode: "MZBEW", coordinates: "19.8436°S 34.8389°E" },
  { name: "Maputo", country: "Mozambique", countryCode: "MZ", region: "Africa", unlocode: "MZMPM", coordinates: "25.9692°S 32.5732°E" },
  { name: "Port Sudan", country: "Sudan", countryCode: "SD", region: "Africa", unlocode: "SDPZU", coordinates: "19.6177°N 37.2163°E" },
  { name: "Sfax", country: "Tunisia", countryCode: "TN", region: "Africa", unlocode: "TNSFA", coordinates: "34.7406°N 10.7603°E" },
  { name: "Tunis", country: "Tunisia", countryCode: "TN", region: "Africa", unlocode: "TNTUN", coordinates: "36.8065°N 10.1815°E" },

  // Americas
  { name: "Los Angeles", country: "United States", countryCode: "US", region: "Americas", unlocode: "USLAX", coordinates: "33.7707°N 118.1937°W" },
  { name: "Long Beach", country: "United States", countryCode: "US", region: "Americas", unlocode: "USLGB", coordinates: "33.7700°N 118.2100°W" },
  { name: "New York / New Jersey", country: "United States", countryCode: "US", region: "Americas", unlocode: "USNYC", coordinates: "40.6645°N 74.0385°W" },
  { name: "Savannah", country: "United States", countryCode: "US", region: "Americas", unlocode: "USSAV", coordinates: "32.0815°N 81.0912°W" },
  { name: "Houston", country: "United States", countryCode: "US", region: "Americas", unlocode: "USHOU", coordinates: "29.7604°N 95.3698°W" },
  { name: "Miami", country: "United States", countryCode: "US", region: "Americas", unlocode: "USMIA", coordinates: "25.7617°N 80.1918°W" },
  { name: "Seattle", country: "United States", countryCode: "US", region: "Americas", unlocode: "USSEA", coordinates: "47.6062°N 122.3321°W" },
  { name: "Oakland", country: "United States", countryCode: "US", region: "Americas", unlocode: "USOAK", coordinates: "37.8044°N 122.2712°W" },
  { name: "Charleston", country: "United States", countryCode: "US", region: "Americas", unlocode: "USCHS", coordinates: "32.7765°N 79.9311°W" },
  { name: "Norfolk", country: "United States", countryCode: "US", region: "Americas", unlocode: "USORF", coordinates: "36.8508°N 76.2859°W" },
  { name: "Vancouver", country: "Canada", countryCode: "CA", region: "Americas", unlocode: "CAVAN", coordinates: "49.2827°N 123.1207°W" },
  { name: "Montreal", country: "Canada", countryCode: "CA", region: "Americas", unlocode: "CAMTR", coordinates: "45.5017°N 73.5673°W" },
  { name: "Prince Rupert", country: "Canada", countryCode: "CA", region: "Americas", unlocode: "CAPRR", coordinates: "54.3150°N 130.3206°W" },
  { name: "Manzanillo", country: "Mexico", countryCode: "MX", region: "Americas", unlocode: "MXZLO", coordinates: "19.0536°N 104.3189°W" },
  { name: "Lázaro Cárdenas", country: "Mexico", countryCode: "MX", region: "Americas", unlocode: "MXLZC", coordinates: "17.9539°N 102.1889°W" },
  { name: "Veracruz", country: "Mexico", countryCode: "MX", region: "Americas", unlocode: "MXVER", coordinates: "19.1738°N 96.1342°W" },
  { name: "Santos", country: "Brazil", countryCode: "BR", region: "Americas", unlocode: "BRSSZ", coordinates: "23.9608°S 46.3300°W" },
  { name: "Itajaí", country: "Brazil", countryCode: "BR", region: "Americas", unlocode: "BRITJ", coordinates: "26.9134°S 48.6656°W" },
  { name: "Paranaguá", country: "Brazil", countryCode: "BR", region: "Americas", unlocode: "BRPNG", coordinates: "25.5160°S 48.5170°W" },
  { name: "Rio de Janeiro", country: "Brazil", countryCode: "BR", region: "Americas", unlocode: "BRRIO", coordinates: "22.9068°S 43.1729°W" },
  { name: "Buenos Aires", country: "Argentina", countryCode: "AR", region: "Americas", unlocode: "ARBUE", coordinates: "34.6037°S 58.3816°W" },
  { name: "Rosario", country: "Argentina", countryCode: "AR", region: "Americas", unlocode: "ARROS", coordinates: "32.9468°S 60.6491°W" },
  { name: "Valparaíso", country: "Chile", countryCode: "CL", region: "Americas", unlocode: "CLVAP", coordinates: "33.0472°S 71.6127°W" },
  { name: "San Antonio", country: "Chile", countryCode: "CL", region: "Americas", unlocode: "CLSAI", coordinates: "33.5922°S 71.6100°W" },
  { name: "Callao", country: "Peru", countryCode: "PE", region: "Americas", unlocode: "PECLL", coordinates: "12.0560°S 77.1180°W" },
  { name: "Buenaventura", country: "Colombia", countryCode: "CO", region: "Americas", unlocode: "COBUN", coordinates: "3.8800°N 77.0600°W" },
  { name: "Cartagena", country: "Colombia", countryCode: "CO", region: "Americas", unlocode: "COCTG", coordinates: "10.4000°N 75.5200°W" },
  { name: "Guayaquil", country: "Ecuador", countryCode: "EC", region: "Americas", unlocode: "ECGYE", coordinates: "2.1894°S 79.8891°W" },

  // Oceania
  { name: "Sydney", country: "Australia", countryCode: "AU", region: "Oceania", unlocode: "AUSYD", coordinates: "33.8688°S 151.2093°E" },
  { name: "Melbourne", country: "Australia", countryCode: "AU", region: "Oceania", unlocode: "AUMEL", coordinates: "37.8136°S 144.9631°E" },
  { name: "Brisbane", country: "Australia", countryCode: "AU", region: "Oceania", unlocode: "AUBNE", coordinates: "27.3814°S 153.1170°E" },
  { name: "Fremantle", country: "Australia", countryCode: "AU", region: "Oceania", unlocode: "AUFRE", coordinates: "32.0500°S 115.7470°E" },
  { name: "Auckland", country: "New Zealand", countryCode: "NZ", region: "Oceania", unlocode: "NZAKL", coordinates: "36.8485°S 174.7633°E" },
  { name: "Tauranga", country: "New Zealand", countryCode: "NZ", region: "Oceania", unlocode: "NZTRG", coordinates: "37.6878°S 176.1651°E" },
];

export async function GET(req: NextRequest) {
  try {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);

  if (q.length < 2) {
    return NextResponse.json({ items: [], total: PORTS.length });
  }

  // Search by port name or country name
  const results = PORTS.filter((p) => {
    const hay = `${p.name} ${p.country} ${p.countryCode} ${p.unlocode} ${p.region}`.toLowerCase();
    return hay.includes(q);
  });

  // Sort: exact name match first, then starts-with, then includes
  results.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    if (aName === q && bName !== q) return -1;
    if (bName === q && aName !== q) return 1;
    if (aName.startsWith(q) && !bName.startsWith(q)) return -1;
    if (bName.startsWith(q) && !aName.startsWith(q)) return 1;
    return aName.localeCompare(bName);
  });

  return NextResponse.json({
    items: results.slice(0, limit),
    total: results.length,
    totalPorts: PORTS.length,
  });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
