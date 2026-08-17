/**
 * Complete world countries + cities database.
 * Our own data — never depends on external APIs.
 *
 * 195 countries (all UN members + observers) with:
 *   - ISO alpha-2 code (RS, AE, US, ...)
 *   - ISO alpha-3 code (SRB, ARE, USA, ...)
 *   - Name, official name
 *   - Flag emoji
 *   - Currency (code, name, symbol)
 *   - Capital
 *   - Phone calling code
 *   - Region, subregion
 *   - 15+ major cities per country
 *
 * This data is embedded in the app and always available.
 */

export interface Country {
  code: string; // ISO alpha-2 (RS, AE, US)
  code3: string; // ISO alpha-3 (SRB, ARE, USA)
  name: string;
  officialName: string;
  flag: string; // emoji
  currency: { code: string; name: string; symbol: string };
  currencies: Array<{ code: string; name: string; symbol: string }>;
  capital: string;
  callingCode: string;
  region: string;
  subregion: string;
  cities: string[];
}

const _raw: Country[] = [
  {
    code: "AE", code3: "ARE", name: "United Arab Emirates", officialName: "United Arab Emirates",
    flag: "🇦🇪", currency: { code: "AED", name: "Dirham", symbol: "د.إ" },
    currencies: [{ code: "AED", name: "Dirham", symbol: "د.إ" }],
    capital: "Abu Dhabi", callingCode: "+971", region: "Asia", subregion: "Western Asia",
    cities: ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Ras Al Khaimah", "Fujairah", "Umm Al Quwain", "Al Ain", "Jebel Ali", "Khor Fakkan", "Dibba Al-Fujairah", "Madinat Zayed", "Ruwais", "Liwa Oasis", "Hatta"],
  },
  {
    code: "SA", code3: "SAU", name: "Saudi Arabia", officialName: "Kingdom of Saudi Arabia",
    flag: "🇸🇦", currency: { code: "SAR", name: "Riyal", symbol: "﷼" },
    currencies: [{ code: "SAR", name: "Riyal", symbol: "﷼" }],
    capital: "Riyadh", callingCode: "+966", region: "Asia", subregion: "Western Asia",
    cities: ["Riyadh", "Jeddah", "Mecca", "Medina", "Dammam", "Khobar", "Tabuk", "Buraidah", "Khamis Mushait", "Hail", "Najran", "Yanbu", "Jubail", "Abha", "Arar", "Jizan", "Taif", "Sakaka"],
  },
  {
    code: "RS", code3: "SRB", name: "Serbia", officialName: "Republic of Serbia",
    flag: "🇷🇸", currency: { code: "RSD", name: "Dinar", symbol: "дин" },
    currencies: [{ code: "RSD", name: "Dinar", symbol: "дин" }],
    capital: "Belgrade", callingCode: "+381", region: "Europe", subregion: "Southern Europe",
    cities: ["Belgrade", "Novi Sad", "Niš", "Kragujevac", "Subotica", "Zrenjanin", "Pančevo", "Čačak", "Kraljevo", "Smederevo", "Leskovac", "Užice", "Vranje", "Šabac", "Sombor", "Požarevac", "Pirot", "Zaječar"],
  },
  {
    code: "US", code3: "USA", name: "United States", officialName: "United States of America",
    flag: "🇺🇸", currency: { code: "USD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "USD", name: "Dollar", symbol: "$" }],
    capital: "Washington, D.C.", callingCode: "+1", region: "Americas", subregion: "Northern America",
    cities: ["New York", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia", "San Antonio", "San Diego", "Dallas", "San Jose", "Austin", "Jacksonville", "Fort Worth", "Columbus", "Charlotte", "San Francisco", "Indianapolis", "Seattle", "Denver", "Boston"],
  },
  {
    code: "GB", code3: "GBR", name: "United Kingdom", officialName: "United Kingdom of Great Britain and Northern Ireland",
    flag: "🇬🇧", currency: { code: "GBP", name: "Pound Sterling", symbol: "£" },
    currencies: [{ code: "GBP", name: "Pound Sterling", symbol: "£" }],
    capital: "London", callingCode: "+44", region: "Europe", subregion: "Northern Europe",
    cities: ["London", "Birmingham", "Manchester", "Glasgow", "Liverpool", "Leeds", "Sheffield", "Edinburgh", "Bristol", "Cardiff", "Belfast", "Leicester", "Coventry", "Bradford", "Nottingham", "Hull", "Newcastle", "Stoke-on-Trent"],
  },
  {
    code: "DE", code3: "DEU", name: "Germany", officialName: "Federal Republic of Germany",
    flag: "🇩🇪", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Berlin", callingCode: "+49", region: "Europe", subregion: "Western Europe",
    cities: ["Berlin", "Hamburg", "Munich", "Cologne", "Frankfurt", "Stuttgart", "Düsseldorf", "Leipzig", "Dortmund", "Essen", "Bremen", "Dresden", "Hannover", "Nuremberg", "Duisburg", "Bochum", "Wuppertal", "Bielefeld"],
  },
  {
    code: "FR", code3: "FRA", name: "France", officialName: "French Republic",
    flag: "🇫🇷", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Paris", callingCode: "+33", region: "Europe", subregion: "Western Europe",
    cities: ["Paris", "Marseille", "Lyon", "Toulouse", "Nice", "Nantes", "Strasbourg", "Montpellier", "Bordeaux", "Lille", "Rennes", "Reims", "Le Havre", "Saint-Étienne", "Toulon", "Grenoble", "Dijon", "Angers"],
  },
  {
    code: "IT", code3: "ITA", name: "Italy", officialName: "Italian Republic",
    flag: "🇮🇹", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Rome", callingCode: "+39", region: "Europe", subregion: "Southern Europe",
    cities: ["Rome", "Milan", "Naples", "Turin", "Palermo", "Genoa", "Bologna", "Florence", "Bari", "Catania", "Venice", "Verona", "Messina", "Padua", "Trieste", "Brescia", "Parma", "Prato"],
  },
  {
    code: "NL", code3: "NLD", name: "Netherlands", officialName: "Kingdom of the Netherlands",
    flag: "🇳🇱", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Amsterdam", callingCode: "+31", region: "Europe", subregion: "Western Europe",
    cities: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht", "Eindhoven", "Tilburg", "Groningen", "Almere", "Breda", "Nijmegen", "Enschede", "Apeldoorn", "Haarlem", "Arnhem", "Amersfoort", "Zaanstad", "Leeuwarden"],
  },
  {
    code: "ES", code3: "ESP", name: "Spain", officialName: "Kingdom of Spain",
    flag: "🇪🇸", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Madrid", callingCode: "+34", region: "Europe", subregion: "Southern Europe",
    cities: ["Madrid", "Barcelona", "Valencia", "Seville", "Zaragoza", "Málaga", "Murcia", "Palma", "Bilbao", "Alicante", "Córdoba", "Valladolid", "Vigo", "Gijón", "Granada", "Elche", "Oviedo", "Badalona"],
  },
  {
    code: "CH", code3: "CHE", name: "Switzerland", officialName: "Swiss Confederation",
    flag: "🇨🇭", currency: { code: "CHF", name: "Swiss Franc", symbol: "₣" },
    currencies: [{ code: "CHF", name: "Swiss Franc", symbol: "₣" }],
    capital: "Bern", callingCode: "+41", region: "Europe", subregion: "Western Europe",
    cities: ["Zurich", "Geneva", "Basel", "Bern", "Lausanne", "Winterthur", "Lucerne", "St. Gallen", "Lugano", "Biel", "Thun", "Köniz", "La Chaux-de-Fonds", "Schaffhausen", "Fribourg", "Vernier", "Chur"],
  },
  {
    code: "TR", code3: "TUR", name: "Turkey", officialName: "Republic of Türkiye",
    flag: "🇹🇷", currency: { code: "TRY", name: "Lira", symbol: "₺" },
    currencies: [{ code: "TRY", name: "Lira", symbol: "₺" }],
    capital: "Ankara", callingCode: "+90", region: "Asia", subregion: "Western Asia",
    cities: ["Istanbul", "Ankara", "Izmir", "Bursa", "Antalya", "Konya", "Adana", "Şanlıurfa", "Gaziantep", "Mersin", "Diyarbakır", "Kayseri", "Eskişehir", "Samsun", "Denizli", "Sakarya", "Trabzon", "Malatya"],
  },
  {
    code: "CN", code3: "CHN", name: "China", officialName: "People's Republic of China",
    flag: "🇨🇳", currency: { code: "CNY", name: "Yuan", symbol: "¥" },
    currencies: [{ code: "CNY", name: "Yuan", symbol: "¥" }],
    capital: "Beijing", callingCode: "+86", region: "Asia", subregion: "Eastern Asia",
    cities: ["Shanghai", "Beijing", "Guangzhou", "Shenzhen", "Tianjin", "Wuhan", "Chongqing", "Chengdu", "Nanjing", "Xi'an", "Hangzhou", "Suzhou", "Shenyang", "Qingdao", "Dalian", "Harbin", "Jinan", "Zhengzhou"],
  },
  {
    code: "IN", code3: "IND", name: "India", officialName: "Republic of India",
    flag: "🇮🇳", currency: { code: "INR", name: "Rupee", symbol: "₹" },
    currencies: [{ code: "INR", name: "Rupee", symbol: "₹" }],
    capital: "New Delhi", callingCode: "+91", region: "Asia", subregion: "Southern Asia",
    cities: ["Mumbai", "Delhi", "Bangalore", "Hyderabad", "Chennai", "Kolkata", "Ahmedabad", "Pune", "Surat", "Jaipur", "Lucknow", "Kanpur", "Nagpur", "Indore", "Bhopal", "Patna", "Vadodara", "Visakhapatnam"],
  },
  {
    code: "JP", code3: "JPN", name: "Japan", officialName: "Japan",
    flag: "🇯🇵", currency: { code: "JPY", name: "Yen", symbol: "¥" },
    currencies: [{ code: "JPY", name: "Yen", symbol: "¥" }],
    capital: "Tokyo", callingCode: "+81", region: "Asia", subregion: "Eastern Asia",
    cities: ["Tokyo", "Yokohama", "Osaka", "Nagoya", "Sapporo", "Fukuoka", "Kobe", "Kyoto", "Kawasaki", "Saitama", "Hiroshima", "Sendai", "Kitakyushu", "Chiba", "Sakai", "Niigata", "Hamamatsu", "Shizuoka"],
  },
  {
    code: "KR", code3: "KOR", name: "South Korea", officialName: "Republic of Korea",
    flag: "🇰🇷", currency: { code: "KRW", name: "Won", symbol: "₩" },
    currencies: [{ code: "KRW", name: "Won", symbol: "₩" }],
    capital: "Seoul", callingCode: "+82", region: "Asia", subregion: "Eastern Asia",
    cities: ["Seoul", "Busan", "Incheon", "Daegu", "Daejeon", "Gwangju", "Suwon", "Ulsan", "Yongin", "Changwon", "Goyang", "Seongnam", "Cheongju", "Jeonju", "Anyang", "Namyangju", "Pohang", "Uijeongbu"],
  },
  {
    code: "SG", code3: "SGP", name: "Singapore", officialName: "Republic of Singapore",
    flag: "🇸🇬", currency: { code: "SGD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "SGD", name: "Dollar", symbol: "$" }],
    capital: "Singapore", callingCode: "+65", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Singapore", "Jurong", "Tampines", "Woodlands", "Bedok", "Sengkang", "Hougang", "Yishun", "Choa Chu Kang", "Ang Mo Kio", "Bukit Batok", "Bukit Merah", "Toa Payoh", "Geylang", "Kallang", "Pasir Ris", "Punggol"],
  },
  {
    code: "MY", code3: "MYS", name: "Malaysia", officialName: "Malaysia",
    flag: "🇲🇾", currency: { code: "MYR", name: "Ringgit", symbol: "RM" },
    currencies: [{ code: "MYR", name: "Ringgit", symbol: "RM" }],
    capital: "Kuala Lumpur", callingCode: "+60", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Kuala Lumpur", "George Town", "Ipoh", "Shah Alam", "Petaling Jaya", "Johor Bahru", "Subang Jaya", "Kuching", "Kota Kinabalu", "Klang", "Kajang", "Seremban", "Iskandar Puteri", "Malacca", "Alor Setar", "Miri", "Kuantan", "Kuala Terengganu"],
  },
  {
    code: "ID", code3: "IDN", name: "Indonesia", officialName: "Republic of Indonesia",
    flag: "🇮🇩", currency: { code: "IDR", name: "Rupiah", symbol: "Rp" },
    currencies: [{ code: "IDR", name: "Rupiah", symbol: "Rp" }],
    capital: "Jakarta", callingCode: "+62", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Jakarta", "Surabaya", "Bandung", "Medan", "Semarang", "Makassar", "Palembang", "Tangerang", "Depok", "Batam", "Bekasi", "Yogyakarta", "Padang", "Malang", "Pekanbaru", "Bandar Lampung", "Banjarmasin", "Denpasar"],
  },
  {
    code: "TH", code3: "THA", name: "Thailand", officialName: "Kingdom of Thailand",
    flag: "🇹🇭", currency: { code: "THB", name: "Baht", symbol: "฿" },
    currencies: [{ code: "THB", name: "Baht", symbol: "฿" }],
    capital: "Bangkok", callingCode: "+66", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Bangkok", "Nonthaburi", "Nakhon Ratchasima", "Chiang Mai", "Hat Yai", "Udon Thani", "Surat Thani", "Khon Kaen", "Nakhon Si Thammarat", "Ubon Ratchathani", "Chonburi", "Nakhon Pathom", "Phitsanulok", "Pattaya", "Songkhla", "Trang", "Krabi", "Phuket"],
  },
  {
    code: "VN", code3: "VNM", name: "Vietnam", officialName: "Socialist Republic of Vietnam",
    flag: "🇻🇳", currency: { code: "VND", name: "Dong", symbol: "₫" },
    currencies: [{ code: "VND", name: "Dong", symbol: "₫" }],
    capital: "Hanoi", callingCode: "+84", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Ho Chi Minh City", "Hanoi", "Hai Phong", "Da Nang", "Can Tho", "Bien Hoa", "Hue", "Nha Trang", "Buon Ma Thuot", "Vung Tau", "Qui Nhon", "Nam Dinh", "Phan Thiet", "Long Xuyen", "Ha Long", "Thai Nguyen", "Thanh Hoa", "Vinh"],
  },
  {
    code: "BR", code3: "BRA", name: "Brazil", officialName: "Federative Republic of Brazil",
    flag: "🇧🇷", currency: { code: "BRL", name: "Real", symbol: "R$" },
    currencies: [{ code: "BRL", name: "Real", symbol: "R$" }],
    capital: "Brasília", callingCode: "+55", region: "Americas", subregion: "South America",
    cities: ["São Paulo", "Rio de Janeiro", "Brasília", "Salvador", "Fortaleza", "Belo Horizonte", "Manaus", "Curitiba", "Recife", "Porto Alegre", "Belém", "Goiânia", "Guarulhos", "Campinas", "São Luís", "Maceió", "Natal", "Florianópolis"],
  },
  {
    code: "CA", code3: "CAN", name: "Canada", officialName: "Canada",
    flag: "🇨🇦", currency: { code: "CAD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "CAD", name: "Dollar", symbol: "$" }],
    capital: "Ottawa", callingCode: "+1", region: "Americas", subregion: "Northern America",
    cities: ["Toronto", "Montreal", "Vancouver", "Calgary", "Edmonton", "Ottawa", "Winnipeg", "Quebec City", "Hamilton", "Halifax", "Victoria", "Saskatoon", "Regina", "London", "St. Catharines", "Mississauga", "Brampton", "Surrey"],
  },
  {
    code: "AU", code3: "AUS", name: "Australia", officialName: "Commonwealth of Australia",
    flag: "🇦🇺", currency: { code: "AUD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "AUD", name: "Dollar", symbol: "$" }],
    capital: "Canberra", callingCode: "+61", region: "Oceania", subregion: "Australia and New Zealand",
    cities: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Gold Coast", "Newcastle", "Canberra", "Sunshine Coast", "Wollongong", "Hobart", "Geelong", "Townsville", "Cairns", "Darwin", "Toowoomba", "Ballarat", "Bendigo"],
  },
  {
    code: "RU", code3: "RUS", name: "Russia", officialName: "Russian Federation",
    flag: "🇷🇺", currency: { code: "RUB", name: "Ruble", symbol: "₽" },
    currencies: [{ code: "RUB", name: "Ruble", symbol: "₽" }],
    capital: "Moscow", callingCode: "+7", region: "Europe", subregion: "Eastern Europe",
    cities: ["Moscow", "Saint Petersburg", "Novosibirsk", "Yekaterinburg", "Kazan", "Nizhny Novgorod", "Chelyabinsk", "Krasnoyarsk", "Samara", "Ufa", "Rostov-on-Don", "Omsk", "Krasnodar", "Voronezh", "Perm", "Volgograd", "Vladivostok", "Sochi"],
  },
  {
    code: "BE", code3: "BEL", name: "Belgium", officialName: "Kingdom of Belgium",
    flag: "🇧🇪", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Brussels", callingCode: "+32", region: "Europe", subregion: "Western Europe",
    cities: ["Brussels", "Antwerp", "Ghent", "Charleroi", "Liège", "Bruges", "Namur", "Leuven", "Mons", "Aalst", "Mechelen", "La Louvière", "Kortrijk", "Hasselt", "Ostend", "Tournai", "Genk", "Seraing"],
  },
  {
    code: "AT", code3: "AUT", name: "Austria", officialName: "Republic of Austria",
    flag: "🇦🇹", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Vienna", callingCode: "+43", region: "Europe", subregion: "Western Europe",
    cities: ["Vienna", "Graz", "Linz", "Salzburg", "Innsbruck", "Klagenfurt", "Villach", "Wels", "Sankt Pölten", "Dornbirn", "Steyr", "Wiener Neustadt", "Feldkirch", "Bregenz", "Leonding", "Klosterneuburg", "Baden", "Wolfsberg"],
  },
  {
    code: "PL", code3: "POL", name: "Poland", officialName: "Republic of Poland",
    flag: "🇵🇱", currency: { code: "PLN", name: "Zloty", symbol: "zł" },
    currencies: [{ code: "PLN", name: "Zloty", symbol: "zł" }],
    capital: "Warsaw", callingCode: "+48", region: "Europe", subregion: "Eastern Europe",
    cities: ["Warsaw", "Kraków", "Łódź", "Wrocław", "Poznań", "Gdańsk", "Szczecin", "Bydgoszcz", "Lublin", "Białystok", "Katowice", "Gdynia", "Częstochowa", "Radom", "Sosnowiec", "Toruń", "Kielce", "Rzeszów"],
  },
  {
    code: "CZ", code3: "CZE", name: "Czech Republic", officialName: "Czech Republic",
    flag: "🇨🇿", currency: { code: "CZK", name: "Koruna", symbol: "Kč" },
    currencies: [{ code: "CZK", name: "Koruna", symbol: "Kč" }],
    capital: "Prague", callingCode: "+420", region: "Europe", subregion: "Eastern Europe",
    cities: ["Prague", "Brno", "Ostrava", "Plzeň", "Liberec", "Olomouc", "Ústí nad Labem", "Hradec Králové", "České Budějovice", "Pardubice", "Havířov", "Zlín", "Kladno", "Most", "Karviná", "Opava", "Frýdek-Místek", "Karlovy Vary"],
  },
  {
    code: "HU", code3: "HUN", name: "Hungary", officialName: "Hungary",
    flag: "🇭🇺", currency: { code: "HUF", name: "Forint", symbol: "Ft" },
    currencies: [{ code: "HUF", name: "Forint", symbol: "Ft" }],
    capital: "Budapest", callingCode: "+36", region: "Europe", subregion: "Eastern Europe",
    cities: ["Budapest", "Debrecen", "Szeged", "Miskolc", "Pécs", "Győr", "Nyíregyháza", "Kecskemét", "Székesfehérvár", "Szombathely", "Szolnok", "Tatabánya", "Érd", "Kaposvár", "Sopron", "Veszprém", "Békéscsaba", "Zalaegerszeg"],
  },
  {
    code: "RO", code3: "ROU", name: "Romania", officialName: "Romania",
    flag: "🇷🇴", currency: { code: "RON", name: "Leu", symbol: "lei" },
    currencies: [{ code: "RON", name: "Leu", symbol: "lei" }],
    capital: "Bucharest", callingCode: "+40", region: "Europe", subregion: "Eastern Europe",
    cities: ["Bucharest", "Cluj-Napoca", "Iași", "Timișoara", "Constanța", "Craiova", "Brașov", "Galați", "Ploiești", "Oradea", "Brăila", "Arad", "Pitești", "Sibiu", "Bacău", "Târgu Mureș", "Baia Mare", "Buzău"],
  },
  {
    code: "GR", code3: "GRC", name: "Greece", officialName: "Hellenic Republic",
    flag: "🇬🇷", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Athens", callingCode: "+30", region: "Europe", subregion: "Southern Europe",
    cities: ["Athens", "Thessaloniki", "Patras", "Heraklion", "Larissa", "Volos", "Ioannina", "Trikala", "Chalcis", "Serres", "Alexandroupoli", "Kalamata", "Katerini", "Rhodes", "Kavala", "Komotini", "Drama", "Lamia"],
  },
  {
    code: "HR", code3: "HRV", name: "Croatia", officialName: "Republic of Croatia",
    flag: "🇭🇷", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Zagreb", callingCode: "+385", region: "Europe", subregion: "Southern Europe",
    cities: ["Zagreb", "Split", "Rijeka", "Osijek", "Zadar", "Slavonski Brod", "Pula", "Karlovac", "Sisak", "Varaždin", "Šibenik", "Dubrovnik", "Bjelovar", "Kaštela", "Vinkovci", "Velika Gorica", "Vukovar", "Đakovo"],
  },
  {
    code: "BA", code3: "BIH", name: "Bosnia and Herzegovina", officialName: "Bosnia and Herzegovina",
    flag: "🇧🇦", currency: { code: "BAM", name: "Mark", symbol: "KM" },
    currencies: [{ code: "BAM", name: "Mark", symbol: "KM" }],
    capital: "Sarajevo", callingCode: "+387", region: "Europe", subregion: "Southern Europe",
    cities: ["Sarajevo", "Banja Luka", "Tuzla", "Zenica", "Mostar", "Bijeljina", "Brčko", "Prijedor", "Trebinje", "Doboj", "Cazin", "Bihać", "Travnik", "Goražde", "Sanski Most", "Gradiška", "Živinice", "Lukavac"],
  },
  {
    code: "MK", code3: "MKD", name: "North Macedonia", officialName: "Republic of North Macedonia",
    flag: "🇲🇰", currency: { code: "MKD", name: "Denar", symbol: "ден" },
    currencies: [{ code: "MKD", name: "Denar", symbol: "ден" }],
    capital: "Skopje", callingCode: "+389", region: "Europe", subregion: "Southern Europe",
    cities: ["Skopje", "Kumanovo", "Bitola", "Prilep", "Tetovo", "Veles", "Štip", "Ohrid", "Gostivar", "Strumica", "Kavadarci", "Kočani", "Kičevo", "Struga", "Radoviš", "Gevgelija", "Debar", "Kratovo"],
  },
  {
    code: "ME", code3: "MNE", name: "Montenegro", officialName: "Montenegro",
    flag: "🇲🇪", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Podgorica", callingCode: "+382", region: "Europe", subregion: "Southern Europe",
    cities: ["Podgorica", "Nikšić", "Pljevlja", "Bijelo Polje", "Cetinje", "Bar", "Herceg Novi", "Berane", "Budva", "Ulcinj", "Tivat", "Rožaje", "Kotor", "Danilovgrad", "Mojkovac", "Plav", "Žabljak", "Plužine"],
  },
  {
    code: "AL", code3: "ALB", name: "Albania", officialName: "Republic of Albania",
    flag: "🇦🇱", currency: { code: "ALL", name: "Lek", symbol: "L" },
    currencies: [{ code: "ALL", name: "Lek", symbol: "L" }],
    capital: "Tirana", callingCode: "+355", region: "Europe", subregion: "Southern Europe",
    cities: ["Tirana", "Durrës", "Vlorë", "Elbasan", "Shkodër", "Korçë", "Fier", "Berat", "Lushnja", "Pogradec", "Kavajë", "Gjirokastër", "Lezhë", "Krujë", "Burrel", "Laç", "Kuçovë", "Sarandë"],
  },
  {
    code: "SI", code3: "SVN", name: "Slovenia", officialName: "Republic of Slovenia",
    flag: "🇸🇮", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Ljubljana", callingCode: "+386", region: "Europe", subregion: "Southern Europe",
    cities: ["Ljubljana", "Maribor", "Celje", "Kranj", "Velenje", "Koper", "Novo Mesto", "Ptuj", "Trbovlje", "Kamnik", "Jesenice", "Nova Gorica", "Domžale", "Škofja Loka", "Murska Sobota", "Postojna", "Krško", "Brežice"],
  },
  {
    code: "EG", code3: "EGY", name: "Egypt", officialName: "Arab Republic of Egypt",
    flag: "🇪🇬", currency: { code: "EGP", name: "Pound", symbol: "£" },
    currencies: [{ code: "EGP", name: "Pound", symbol: "£" }],
    capital: "Cairo", callingCode: "+20", region: "Africa", subregion: "Northern Africa",
    cities: ["Cairo", "Alexandria", "Giza", "Shubra El-Kheima", "Port Said", "Suez", "Luxor", "Mansoura", "El-Mahalla El-Kubra", "Tanta", "Asyut", "Ismailia", "Fayyum", "Zagazig", "Aswan", "Damietta", "Damanhur", "Minya"],
  },
  {
    code: "ZA", code3: "ZAF", name: "South Africa", officialName: "Republic of South Africa",
    flag: "🇿🇦", currency: { code: "ZAR", name: "Rand", symbol: "R" },
    currencies: [{ code: "ZAR", name: "Rand", symbol: "R" }],
    capital: "Pretoria", callingCode: "+27", region: "Africa", subregion: "Southern Africa",
    cities: ["Johannesburg", "Cape Town", "Durban", "Pretoria", "Port Elizabeth", "Bloemfontein", "East London", "Pietermaritzburg", "Polokwane", "Nelspruit", "Kimberley", "Rustenburg", "Soweto", "Tembisa", "Vereeniging", "Boksburg", "Welkom", "Krugersdorp"],
  },
  {
    code: "NG", code3: "NGA", name: "Nigeria", officialName: "Federal Republic of Nigeria",
    flag: "🇳🇬", currency: { code: "NGN", name: "Naira", symbol: "₦" },
    currencies: [{ code: "NGN", name: "Naira", symbol: "₦" }],
    capital: "Abuja", callingCode: "+234", region: "Africa", subregion: "Western Africa",
    cities: ["Lagos", "Kano", "Ibadan", "Abuja", "Port Harcourt", "Benin City", "Kaduna", "Maiduguri", "Zaria", "Aba", "Jos", "Ilorin", "Oyo", "Enugu", "Abeokuta", "Onitsha", "Warri", "Sokoto"],
  },
  {
    code: "SN", code3: "SEN", name: "Senegal", officialName: "Republic of Senegal",
    flag: "🇸🇳", currency: { code: "XOF", name: "CFA Franc", symbol: "₣" },
    currencies: [{ code: "XOF", name: "CFA Franc", symbol: "₣" }],
    capital: "Dakar", callingCode: "+221", region: "Africa", subregion: "Western Africa",
    cities: ["Dakar", "Touba", "Thiès", "Rufisque", "Kaolack", "Ziguinchor", "Saint-Louis", "Mbour", "Diourbel", "Tambacounda", "Richard-Toll", "Tivaouane", "Louga", "Matam", "Kolda", "Sédhiou", "Bignona", "Kaffrine"],
  },
  {
    code: "CI", code3: "CIV", name: "Ivory Coast", officialName: "Republic of Côte d'Ivoire",
    flag: "🇨🇮", currency: { code: "XOF", name: "CFA Franc", symbol: "₣" },
    currencies: [{ code: "XOF", name: "CFA Franc", symbol: "₣" }],
    capital: "Yamoussoukro", callingCode: "+225", region: "Africa", subregion: "Western Africa",
    cities: ["Abidjan", "Bouaké", "Yamoussoukro", "Daloa", "Korhogo", "San-Pédro", "Man", "Divo", "Gagnoa", "Anyama", "Abobo", "Séguéla", "Bondo", "Odienné", "Bingerville", "Grand-Bassam", "Dabou", "Touba"],
  },
  {
    code: "QA", code3: "QAT", name: "Qatar", officialName: "State of Qatar",
    flag: "🇶🇦", currency: { code: "QAR", name: "Riyal", symbol: "﷼" },
    currencies: [{ code: "QAR", name: "Riyal", symbol: "﷼" }],
    capital: "Doha", callingCode: "+974", region: "Asia", subregion: "Western Asia",
    cities: ["Doha", "Al Rayyan", "Umm Salal Muhammad", "Al Wakrah", "Al Khor", "Lusail", "Madinat ash Shamal", "Dukhan", "Mesaieed", "Ras Laffan", "Al Daayen", "Zekreet", "Fuwayrit", "Khor Al Adaid", "Simaisma", "Abu Samra", "Umm Bab"],
  },
  {
    code: "KW", code3: "KWT", name: "Kuwait", officialName: "State of Kuwait",
    flag: "🇰🇼", currency: { code: "KWD", name: "Dinar", symbol: "د.ك" },
    currencies: [{ code: "KWD", name: "Dinar", symbol: "د.ك" }],
    capital: "Kuwait City", callingCode: "+965", region: "Asia", subregion: "Western Asia",
    cities: ["Kuwait City", "Al Ahmadi", "Hawalli", "Salmiya", "Jahra", "Farwaniya", "Fahaheel", "Mahboula", "Jaber Al Ali", "Bayan", "Sabah Al Salem", "Mangaf", "Rumaithiya", "Khaitan", "Abbasiya", "Fintas", "Kaifan", "Shuwaikh"],
  },
  {
    code: "OM", code3: "OMN", name: "Oman", officialName: "Sultanate of Oman",
    flag: "🇴🇲", currency: { code: "OMR", name: "Rial", symbol: "﷼" },
    currencies: [{ code: "OMR", name: "Rial", symbol: "﷼" }],
    capital: "Muscat", callingCode: "+968", region: "Asia", subregion: "Western Asia",
    cities: ["Muscat", "Salalah", "Sohar", "Sib", "Nizwa", "Sur", "Sohar", "Bahla", "Ibri", "Rustaq", "Buraimi", "Khasab", "Bawshar", "Ibra", "Bidiyah", "Sumail", "Bahla", "Adam"],
  },
  {
    code: "IR", code3: "IRN", name: "Iran", officialName: "Islamic Republic of Iran",
    flag: "🇮🇷", currency: { code: "IRR", name: "Rial", symbol: "﷼" },
    currencies: [{ code: "IRR", name: "Rial", symbol: "﷼" }],
    capital: "Tehran", callingCode: "+98", region: "Asia", subregion: "Southern Asia",
    cities: ["Tehran", "Mashhad", "Isfahan", "Karaj", "Shiraz", "Tabriz", "Qom", "Ahvaz", "Kermanshah", "Urmia", "Rasht", "Kerman", "Zahedan", "Hamadan", "Yazd", "Arak", "Bandar Abbas", "Eslamshahr"],
  },
  {
    code: "IQ", code3: "IRQ", name: "Iraq", officialName: "Republic of Iraq",
    flag: "🇮🇶", currency: { code: "IQD", name: "Dinar", symbol: "ع.د" },
    currencies: [{ code: "IQD", name: "Dinar", symbol: "ع.د" }],
    capital: "Baghdad", callingCode: "+964", region: "Asia", subregion: "Western Asia",
    cities: ["Baghdad", "Basra", "Mosul", "Erbil", "Sulaymaniyah", "Najaf", "Karbala", "Kirkuk", "Nasiriyah", "Hillah", "Kut", "Fallujah", "Tikrit", "Ramadi", "BaQuba", "Duhok", "Amarah", "Samawah"],
  },
  {
    code: "MA", code3: "MAR", name: "Morocco", officialName: "Kingdom of Morocco",
    flag: "🇲🇦", currency: { code: "MAD", name: "Dirham", symbol: "د.م." },
    currencies: [{ code: "MAD", name: "Dirham", symbol: "د.م." }],
    capital: "Rabat", callingCode: "+212", region: "Africa", subregion: "Northern Africa",
    cities: ["Casablanca", "Rabat", "Marrakesh", "Fes", "Tangier", "Meknes", "Agadir", "Oujda", "Kenitra", "Tetouan", "Safi", "Mohammedia", "Khouribga", "El Jadida", "Beni Mellal", "Aït Melloul", "Nador", "Taza"],
  },
  {
    code: "TN", code3: "TUN", name: "Tunisia", officialName: "Republic of Tunisia",
    flag: "🇹🇳", currency: { code: "TND", name: "Dinar", symbol: "د.ت" },
    currencies: [{ code: "TND", name: "Dinar", symbol: "د.ت" }],
    capital: "Tunis", callingCode: "+216", region: "Africa", subregion: "Northern Africa",
    cities: ["Tunis", "Sfax", "Sousse", "Kairouan", "Bizerte", "Gabès", "Ariana", "Gafsa", "Monastir", "Ben Arous", "Kasserine", "Tataouine", "Béja", "Le Kef", "Mahdia", "Nabeul", "Médenine", "Sidi Bouzid"],
  },
  {
    code: "DZ", code3: "DZA", name: "Algeria", officialName: "People's Democratic Republic of Algeria",
    flag: "🇩🇿", currency: { code: "DZD", name: "Dinar", symbol: "د.ج" },
    currencies: [{ code: "DZD", name: "Dinar", symbol: "د.ج" }],
    capital: "Algiers", callingCode: "+213", region: "Africa", subregion: "Northern Africa",
    cities: ["Algiers", "Oran", "Constantine", "Annaba", "Blida", "Batna", "Djelfa", "Sétif", "Sidi Bel Abbès", "Biskra", "Tébessa", "Tlemcen", "Tiaret", "Béjaïa", "Tizi Ouzou", "Skikda", "Medea", "M'Sila"],
  },
  {
    code: "LY", code3: "LBY", name: "Libya", officialName: "State of Libya",
    flag: "🇱🇾", currency: { code: "LYD", name: "Dinar", symbol: "ل.د" },
    currencies: [{ code: "LYD", name: "Dinar", symbol: "ل.د" }],
    capital: "Tripoli", callingCode: "+218", region: "Africa", subregion: "Northern Africa",
    cities: ["Tripoli", "Benghazi", "Misrata", "Zawiya", "Zliten", "Ajdabiya", "Tobruk", "Sabha", "Derna", "Ghadames", "Khoms", "Bani Walid", "Sirte", "Murzuq", "Benghazi", "Bayda", "Zuwara", "Surt"],
  },
  {
    code: "SD", code3: "SDN", name: "Sudan", officialName: "Republic of the Sudan",
    flag: "🇸🇩", currency: { code: "SDG", name: "Pound", symbol: "£" },
    currencies: [{ code: "SDG", name: "Pound", symbol: "£" }],
    capital: "Khartoum", callingCode: "+249", region: "Africa", subregion: "Northern Africa",
    cities: ["Khartoum", "Omdurman", "Khartoum North", "Port Sudan", "Kassala", "Nyala", "Al-Fashir", "Juba", "Wad Madani", "El Obeid", "Dongola", "Kusti", "Sennar", "Atbara", "Ed Damazin", "Merowe", "Kadugli", "Rabak"],
  },
  {
    code: "KE", code3: "KEN", name: "Kenya", officialName: "Republic of Kenya",
    flag: "🇰🇪", currency: { code: "KES", name: "Shilling", symbol: "KSh" },
    currencies: [{ code: "KES", name: "Shilling", symbol: "KSh" }],
    capital: "Nairobi", callingCode: "+254", region: "Africa", subregion: "Eastern Africa",
    cities: ["Nairobi", "Mombasa", "Kisumu", "Nakuru", "Eldoret", "Ruiru", "Kikuyu", "Kangundo-Tala", "Malindi", "Naivasha", "Kitui", "Machakos", "Thika", "Kilifi", "Bungoma", "Garissa", "Kakamega", "Kericho"],
  },
  {
    code: "TZ", code3: "TZA", name: "Tanzania", officialName: "United Republic of Tanzania",
    flag: "🇹🇿", currency: { code: "TZS", name: "Shilling", symbol: "TSh" },
    currencies: [{ code: "TZS", name: "Shilling", symbol: "TSh" }],
    capital: "Dodoma", callingCode: "+255", region: "Africa", subregion: "Eastern Africa",
    cities: ["Dar es Salaam", "Mwanza", "Arusha", "Dodoma", "Mbeya", "Morogoro", "Tanga", "Kahama", "Tabora", "Zanzibar", "Kigoma", "Sumbawanga", "Kasulu", "Songea", "Moshi", "Musoma", "Iringa", "Shinyanga"],
  },
  {
    code: "GH", code3: "GHA", name: "Ghana", officialName: "Republic of Ghana",
    flag: "🇬🇭", currency: { code: "GHS", name: "Cedi", symbol: "₵" },
    currencies: [{ code: "GHS", name: "Cedi", symbol: "₵" }],
    capital: "Accra", callingCode: "+233", region: "Africa", subregion: "Western Africa",
    cities: ["Accra", "Kumasi", "Tamale", "Sekondi-Takoradi", "Sunyani", "Cape Coast", "Obuasi", "Tema", "Teshie", "Madina", "Koforidua", "Wa", "Ho", "Bolgatanga", "Nungua", "Techiman", "Tamale", "Winneba"],
  },
  {
    code: "ET", code3: "ETH", name: "Ethiopia", officialName: "Federal Democratic Republic of Ethiopia",
    flag: "🇪🇹", currency: { code: "ETB", name: "Birr", symbol: "Br" },
    currencies: [{ code: "ETB", name: "Birr", symbol: "Br" }],
    capital: "Addis Ababa", callingCode: "+251", region: "Africa", subregion: "Eastern Africa",
    cities: ["Addis Ababa", "Dire Dawa", "Mek'ele", "Gondar", "Adama", "Hawassa", "Bahir Dar", "Dessie", "Jimma", "Jijiga", "Shashamane", "Bale Robe", "Arsi Negele", "Hosaena", "Harar", "Dilla", "Adigrat", "Debre Berhan"],
  },
  {
    code: "MX", code3: "MEX", name: "Mexico", officialName: "United Mexican States",
    flag: "🇲🇽", currency: { code: "MXN", name: "Peso", symbol: "$" },
    currencies: [{ code: "MXN", name: "Peso", symbol: "$" }],
    capital: "Mexico City", callingCode: "+52", region: "Americas", subregion: "Central America",
    cities: ["Mexico City", "Guadalajara", "Monterrey", "Puebla", "Tijuana", "León", "Ciudad Juárez", "Zapopan", "Mérida", "Cancún", "Acapulco", "Querétaro", "Hermosillo", "Aguascalientes", "Culiacán", "Morelia", "Saltillo", "Veracruz"],
  },
  {
    code: "AR", code3: "ARG", name: "Argentina", officialName: "Argentine Republic",
    flag: "🇦🇷", currency: { code: "ARS", name: "Peso", symbol: "$" },
    currencies: [{ code: "ARS", name: "Peso", symbol: "$" }],
    capital: "Buenos Aires", callingCode: "+54", region: "Americas", subregion: "South America",
    cities: ["Buenos Aires", "Córdoba", "Rosario", "Mendoza", "La Plata", "Mar del Plata", "Tucumán", "Salta", "Santa Fe", "San Juan", "Resistencia", "Neuquén", "Santiago del Estero", "Corrientes", "Posadas", "Bahía Blanca", "Paraná", "Formosa"],
  },
  {
    code: "CL", code3: "CHL", name: "Chile", officialName: "Republic of Chile",
    flag: "🇨🇱", currency: { code: "CLP", name: "Peso", symbol: "$" },
    currencies: [{ code: "CLP", name: "Peso", symbol: "$" }],
    capital: "Santiago", callingCode: "+56", region: "Americas", subregion: "South America",
    cities: ["Santiago", "Valparaíso", "Concepción", "Antofagasta", "Viña del Mar", "La Serena", "Temuco", "Rancagua", "Talca", "Arica", "Iquique", "Puerto Montt", "Coquimbo", "Chillán", "Calama", "Osorno", "Valdivia", "Punta Arenas"],
  },
  {
    code: "CO", code3: "COL", name: "Colombia", officialName: "Republic of Colombia",
    flag: "🇨🇴", currency: { code: "COP", name: "Peso", symbol: "$" },
    currencies: [{ code: "COP", name: "Peso", symbol: "$" }],
    capital: "Bogotá", callingCode: "+57", region: "Americas", subregion: "South America",
    cities: ["Bogotá", "Medellín", "Cali", "Barranquilla", "Cartagena", "Cúcuta", "Soledad", "Ibagué", "Bucaramanga", "Soacha", "Santa Marta", "Villavicencio", "Bello", "Valledupar", "Pereira", "Manizales", "Buenaventura", "Neiva"],
  },
  {
    code: "PE", code3: "PER", name: "Peru", officialName: "Republic of Peru",
    flag: "🇵🇪", currency: { code: "PEN", name: "Sol", symbol: "S/" },
    currencies: [{ code: "PEN", name: "Sol", symbol: "S/" }],
    capital: "Lima", callingCode: "+51", region: "Americas", subregion: "South America",
    cities: ["Lima", "Arequipa", "Trujillo", "Chiclayo", "Piura", "Iquitos", "Cusco", "Chimbote", "Huancayo", "Tacna", "Juliaca", "Ica", "Sullana", "Ayacucho", "Cajamarca", "Pucallpa", "Tumbes", "Talara"],
  },
  {
    code: "EC", code3: "ECU", name: "Ecuador", officialName: "Republic of Ecuador",
    flag: "🇪🇨", currency: { code: "USD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "USD", name: "Dollar", symbol: "$" }],
    capital: "Quito", callingCode: "+593", region: "Americas", subregion: "South America",
    cities: ["Guayaquil", "Quito", "Cuenca", "Santo Domingo", "Machala", "Manta", "Portoviejo", "Ambato", "Riobamba", "Loja", "Esmeraldas", "Ibarra", "Quevedo", "Latacunga", "Milagro", "Babahoyo", "Santa Elena", "Puyo"],
  },
  {
    code: "VE", code3: "VEN", name: "Venezuela", officialName: "Bolivarian Republic of Venezuela",
    flag: "🇻🇪", currency: { code: "VES", name: "Bolívar", symbol: "Bs" },
    currencies: [{ code: "VES", name: "Bolívar", symbol: "Bs" }],
    capital: "Caracas", callingCode: "+58", region: "Americas", subregion: "South America",
    cities: ["Caracas", "Maracaibo", "Valencia", "Barquisimeto", "Ciudad Guayana", "Maracay", "Barcelona", "Maturín", "San Cristóbal", "Ciudad Bolívar", "Cumaná", "Mérida", "Cabimas", "Coro", "Los Teques", "Punto Fijo", "Petare", "Acarigua"],
  },
  {
    code: "PT", code3: "PRT", name: "Portugal", officialName: "Portuguese Republic",
    flag: "🇵🇹", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Lisbon", callingCode: "+351", region: "Europe", subregion: "Southern Europe",
    cities: ["Lisbon", "Porto", "Braga", "Coimbra", "Funchal", "Setúbal", "Aveiro", "Faro", "Leiria", "Viseu", "Évora", "Vila Nova de Gaia", "Guimarães", "Amadora", "Vila Franca de Xira", "Almada", "Seixal", "Barreiro"],
  },
  {
    code: "IE", code3: "IRL", name: "Ireland", officialName: "Ireland",
    flag: "🇮🇪", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Dublin", callingCode: "+353", region: "Europe", subregion: "Northern Europe",
    cities: ["Dublin", "Cork", "Limerick", "Galway", "Waterford", "Drogheda", "Dundalk", "Bray", "Navan", "Ennis", "Kilkenny", "Tralee", "Carlow", "Newbridge", "Naas", "Athlone", "Portlaoise", "Mullingar"],
  },
  {
    code: "SE", code3: "SWE", name: "Sweden", officialName: "Kingdom of Sweden",
    flag: "🇸🇪", currency: { code: "SEK", name: "Krona", symbol: "kr" },
    currencies: [{ code: "SEK", name: "Krona", symbol: "kr" }],
    capital: "Stockholm", callingCode: "+46", region: "Europe", subregion: "Northern Europe",
    cities: ["Stockholm", "Gothenburg", "Malmö", "Uppsala", "Västerås", "Örebro", "Linköping", "Helsingborg", "Jönköping", "Norrköping", "Lund", "Umeå", "Gävle", "Borås", "Sundsvall", "Eskilstuna", "Karlstad", "Växjö"],
  },
  {
    code: "DK", code3: "DNK", name: "Denmark", officialName: "Kingdom of Denmark",
    flag: "🇩🇰", currency: { code: "DKK", name: "Krone", symbol: "kr" },
    currencies: [{ code: "DKK", name: "Krone", symbol: "kr" }],
    capital: "Copenhagen", callingCode: "+45", region: "Europe", subregion: "Northern Europe",
    cities: ["Copenhagen", "Aarhus", "Odense", "Aalborg", "Frederiksberg", "Esbjerg", "Randers", "Kolding", "Horsens", "Vejle", "Roskilde", "Herning", "Hørsholm", "Helsingør", "Silkeborg", "Næstved", "Greve", "Fredericia"],
  },
  {
    code: "NO", code3: "NOR", name: "Norway", officialName: "Kingdom of Norway",
    flag: "🇳🇴", currency: { code: "NOK", name: "Krone", symbol: "kr" },
    currencies: [{ code: "NOK", name: "Krone", symbol: "kr" }],
    capital: "Oslo", callingCode: "+47", region: "Europe", subregion: "Northern Europe",
    cities: ["Oslo", "Bergen", "Trondheim", "Stavanger", "Drammen", "Fredrikstad", "Kristiansand", "Sandnes", "Tromsø", "Sarpsborg", "Skien", "Ålesund", "Sandefjord", "Haugesund", "Tønsberg", "Moss", "Porsgrunn", "Bodø"],
  },
  {
    code: "FI", code3: "FIN", name: "Finland", officialName: "Republic of Finland",
    flag: "🇫🇮", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Helsinki", callingCode: "+358", region: "Europe", subregion: "Northern Europe",
    cities: ["Helsinki", "Espoo", "Tampere", "Vantaa", "Oulu", "Turku", "Jyväskylä", "Lahti", "Kuopio", "Pori", "Joensuu", "Lappeenranta", "Hämeenlinna", "Vaasa", "Seinäjoki", "Rovaniemi", "Mikkeli", "Kotka"],
  },
  {
    code: "NZ", code3: "NZL", name: "New Zealand", officialName: "New Zealand",
    flag: "🇳🇿", currency: { code: "NZD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "NZD", name: "Dollar", symbol: "$" }],
    capital: "Wellington", callingCode: "+64", region: "Oceania", subregion: "Australia and New Zealand",
    cities: ["Auckland", "Wellington", "Christchurch", "Hamilton", "Tauranga", "Napier-Hastings", "Dunedin", "Palmerston North", "Nelson", "Rotorua", "New Plymouth", "Whangarei", "Invercargill", "Whanganui", "Gisborne", "Timaru", "Taupo", "Levin"],
  },
  {
    code: "PH", code3: "PHL", name: "Philippines", officialName: "Republic of the Philippines",
    flag: "🇵🇭", currency: { code: "PHP", name: "Peso", symbol: "₱" },
    currencies: [{ code: "PHP", name: "Peso", symbol: "₱" }],
    capital: "Manila", callingCode: "+63", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Manila", "Quezon City", "Davao", "Caloocan", "Cebu City", "Zamboanga", "Antipolo", "Pasig", "Taguig", "Cagayan de Oro", "Parañaque", "Valenzuela", "Las Piñas", "Makati", "Bacoor", "General Santos", "Muntinlupa", "Iloilo"],
  },
  {
    code: "PK", code3: "PAK", name: "Pakistan", officialName: "Islamic Republic of Pakistan",
    flag: "🇵🇰", currency: { code: "PKR", name: "Rupee", symbol: "₨" },
    currencies: [{ code: "PKR", name: "Rupee", symbol: "₨" }],
    capital: "Islamabad", callingCode: "+92", region: "Asia", subregion: "Southern Asia",
    cities: ["Karachi", "Lahore", "Faisalabad", "Rawalpindi", "Multan", "Hyderabad", "Gujranwala", "Peshawar", "Quetta", "Islamabad", "Bahawalpur", "Sargodha", "Sialkot", "Sukkur", "Larkana", "Sheikhupura", "Bannu", "Rahim Yar Khan"],
  },
  {
    code: "BD", code3: "BGD", name: "Bangladesh", officialName: "People's Republic of Bangladesh",
    flag: "🇧🇩", currency: { code: "BDT", name: "Taka", symbol: "৳" },
    currencies: [{ code: "BDT", name: "Taka", symbol: "৳" }],
    capital: "Dhaka", callingCode: "+880", region: "Asia", subregion: "Southern Asia",
    cities: ["Dhaka", "Chittagong", "Khulna", "Rajshahi", "Sylhet", "Mymensingh", "Rangpur", "Comilla", "Narayanganj", "Gazipur", "Jessore", "Dinajpur", "Bogra", "Tangail", "Nawabganj", "Kushtia", "Pabna", "Naogaon"],
  },
  {
    code: "LK", code3: "LKA", name: "Sri Lanka", officialName: "Democratic Socialist Republic of Sri Lanka",
    flag: "🇱🇰", currency: { code: "LKR", name: "Rupee", symbol: "₨" },
    currencies: [{ code: "LKR", name: "Rupee", symbol: "₨" }],
    capital: "Sri Jayawardenepura Kotte", callingCode: "+94", region: "Asia", subregion: "Southern Asia",
    cities: ["Colombo", "Sri Jayawardenepura Kotte", "Dehiwala", "Moratuwa", "Negombo", "Kandy", "Galle", "Trincomalee", "Batticaloa", "Jaffna", "Anuradhapura", "Matara", "Ratnapura", "Badulla", "Kurunegala", "Polonnaruwa", "Hambantota", "Nuwara Eliya"],
  },
  {
    code: "HK", code3: "HKG", name: "Hong Kong", officialName: "Hong Kong Special Administrative Region of China",
    flag: "🇭🇰", currency: { code: "HKD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "HKD", name: "Dollar", symbol: "$" }],
    capital: "Hong Kong", callingCode: "+852", region: "Asia", subregion: "Eastern Asia",
    cities: ["Hong Kong", "Kowloon", "Tsuen Wan", "Yuen Long Kau Hui", "Tuen Mun", "Tai Po", "Sha Tin", "Sai Kung", "Tseung Kwan O", "Tin Shui Wai", "Tung Chung", "Fanling", "Sheung Shui", "Ma On Shan", "Tsz Wan Shan", "Chai Wan", "Wong Tai Sin", "Kwun Tong"],
  },
  {
    code: "TW", code3: "TWN", name: "Taiwan", officialName: "Taiwan",
    flag: "🇹🇼", currency: { code: "TWD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "TWD", name: "Dollar", symbol: "$" }],
    capital: "Taipei", callingCode: "+886", region: "Asia", subregion: "Eastern Asia",
    cities: ["Taipei", "New Taipei", "Kaohsiung", "Taichung", "Tainan", "Taoyuan", "Hsinchu", "Keelung", "Chiayi", "Hualien", "Yilan", "Pingtung", "Changhua", "Yunlin", "Miaoli", "Nantou", "Taitung", "Penghu"],
  },
  {
    code: "BG", code3: "BGR", name: "Bulgaria", officialName: "Republic of Bulgaria",
    flag: "🇧🇬", currency: { code: "BGN", name: "Lev", symbol: "лв" },
    currencies: [{ code: "BGN", name: "Lev", symbol: "лв" }],
    capital: "Sofia", callingCode: "+359", region: "Europe", subregion: "Eastern Europe",
    cities: ["Sofia", "Plovdiv", "Varna", "Burgas", "Ruse", "Stara Zagora", "Pleven", "Sliven", "Dobrich", "Shumen", "Pernik", "Haskovo", "Yambol", "Pazardzhik", "Blagoevgrad", "Veliko Tarnovo", "Vratsa", "Gabrovo"],
  },
  {
    code: "UA", code3: "UKR", name: "Ukraine", officialName: "Ukraine",
    flag: "🇺🇦", currency: { code: "UAH", name: "Hryvnia", symbol: "₴" },
    currencies: [{ code: "UAH", name: "Hryvnia", symbol: "₴" }],
    capital: "Kyiv", callingCode: "+380", region: "Europe", subregion: "Eastern Europe",
    cities: ["Kyiv", "Kharkiv", "Odesa", "Dnipro", "Zaporizhzhia", "Lviv", "Kryvyi Rih", "Mykolaiv", "Mariupol", "Vinnytsia", "Kherson", "Poltava", "Chernihiv", "Cherkasy", "Sumy", "Zhytomyr", "Rivne", "Kamianske"],
  },
  {
    code: "SK", code3: "SVK", name: "Slovakia", officialName: "Slovak Republic",
    flag: "🇸🇰", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Bratislava", callingCode: "+421", region: "Europe", subregion: "Eastern Europe",
    cities: ["Bratislava", "Košice", "Prešov", "Žilina", "Banská Bystrica", "Nitra", "Trnava", "Trenčín", "Martin", "Poprad", "Prievidza", "Zvolen", "Považská Bystrica", "Michalovce", "Spišská Nová Ves", "Komárno", "Levice", "Humenné"],
  },
  {
    code: "LT", code3: "LTU", name: "Lithuania", officialName: "Republic of Lithuania",
    flag: "🇱🇹", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Vilnius", callingCode: "+370", region: "Europe", subregion: "Northern Europe",
    cities: ["Vilnius", "Kaunas", "Klaipėda", "Šiauliai", "Panevėžys", "Alytus", "Marijampolė", "Mažeikiai", "Jonava", "Utena", "Kėdainiai", "Telšiai", "Visaginas", "Tauragė", "Ukmergė", "Plungė", "Kretinga", "Radviliškis"],
  },
  {
    code: "LV", code3: "LVA", name: "Latvia", officialName: "Republic of Latvia",
    flag: "🇱🇻", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Riga", callingCode: "+371", region: "Europe", subregion: "Northern Europe",
    cities: ["Riga", "Daugavpils", "Liepāja", "Jelgava", "Jūrmala", "Ventspils", "Rēzekne", "Valmiera", "Jēkabpils", "Ogre", "Tukums", "Cēsis", "Salaspils", "Kuldīga", "Olaine", "Saldus", "Kārsava", "Dobele"],
  },
  {
    code: "EE", code3: "EST", name: "Estonia", officialName: "Republic of Estonia",
    flag: "🇪🇪", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Tallinn", callingCode: "+372", region: "Europe", subregion: "Northern Europe",
    cities: ["Tallinn", "Tartu", "Narva", "Pärnu", "Kohtla-Järve", "Viljandi", "Rakvere", "Maardu", "Sillamäe", "Kuressaare", "Võru", "Valga", "Haapsalu", "Jõhvi", "Paide", "Keila", "Põlva", "Tapa"],
  },
  {
    code: "IS", code3: "ISL", name: "Iceland", officialName: "Iceland",
    flag: "🇮🇸", currency: { code: "ISK", name: "Krona", symbol: "kr" },
    currencies: [{ code: "ISK", name: "Krona", symbol: "kr" }],
    capital: "Reykjavik", callingCode: "+354", region: "Europe", subregion: "Northern Europe",
    cities: ["Reykjavik", "Kópavogur", "Hafnarfjörður", "Akureyri", "Reykjanesbær", "Garðabær", "Mosfellsbær", "Akranes", "Selfoss", "Vestmannaeyjar", "Seltjarnarnes", "Grindavík", "Ísafjörður", "Egilsstaðir", "Húsavík", "Borgarnes", "Neskaupstaður", "Stykkishólmur"],
  },
  {
    code: "LU", code3: "LUX", name: "Luxembourg", officialName: "Grand Duchy of Luxembourg",
    flag: "🇱🇺", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Luxembourg", callingCode: "+352", region: "Europe", subregion: "Western Europe",
    cities: ["Luxembourg", "Esch-sur-Alzette", "Differdange", "Dudelange", "Pétange", "Sanem", "Hesperange", "Bettembourg", "Mamer", "Strassen", "Diekirch", "Ettelbruck", "Wiltz", "Grevenmacher", "Remich", "Echternach", "Redange", "Vianden"],
  },
  {
    code: "MT", code3: "MLT", name: "Malta", officialName: "Republic of Malta",
    flag: "🇲🇹", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Valletta", callingCode: "+356", region: "Europe", subregion: "Southern Europe",
    cities: ["Valletta", "Birkirkara", "Mosta", "Qormi", "Żabbar", "Sliema", "San Pawl il-Baħar", "Naxxar", "Fgura", "Żejtun", "Rabat", "Marsaskala", "Birżebbuġa", "Attard", "Gzira", "Marsaxlokk", "Mdina", "Victoria"],
  },
  {
    code: "CY", code3: "CYP", name: "Cyprus", officialName: "Republic of Cyprus",
    flag: "🇨🇾", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Nicosia", callingCode: "+357", region: "Asia", subregion: "Western Asia",
    cities: ["Nicosia", "Limassol", "Larnaca", "Famagusta", "Paphos", "Kyrenia", "Latsia", "Strovolos", "Lakatamia", "Yermasogeia", "Agios Athanasios", "Engomi", "Aradippou", "Mesa Geitonia", "Paralimni", "Dali", "Tseri", "Aglandjia"],
  },
  {
    code: "UY", code3: "URY", name: "Uruguay", officialName: "Oriental Republic of Uruguay",
    flag: "🇺🇾", currency: { code: "UYU", name: "Peso", symbol: "$U" },
    currencies: [{ code: "UYU", name: "Peso", symbol: "$U" }],
    capital: "Montevideo", callingCode: "+598", region: "Americas", subregion: "South America",
    cities: ["Montevideo", "Salto", "Ciudad de la Costa", "Paysandú", "Las Piedras", "Rivera", "Maldonado", "Tacuarembó", "Melo", "Mercedes", "Artigas", "Minas", "San José", "Durazno", "Florida", "Treinta y Tres", "Rocha", "Fray Bentos"],
  },
  {
    code: "PY", code3: "PRY", name: "Paraguay", officialName: "Republic of Paraguay",
    flag: "🇵🇾", currency: { code: "PYG", name: "Guaraní", symbol: "₲" },
    currencies: [{ code: "PYG", name: "Guaraní", symbol: "₲" }],
    capital: "Asunción", callingCode: "+595", region: "Americas", subregion: "South America",
    cities: ["Asunción", "Ciudad del Este", "San Lorenzo", "Luque", "Capiatá", "Lambaré", "Fernando de la Mora", "Limpio", "Nemby", "Encarnación", "Mariano Roque Alonso", "Pedro Juan Caballero", "Villa Elisa", "Caaguazú", "Coronel Oviedo", "Villarrica", "Caacupé", "San Antonio"],
  },
  {
    code: "BO", code3: "BOL", name: "Bolivia", officialName: "Plurinational State of Bolivia",
    flag: "🇧🇴", currency: { code: "BOB", name: "Boliviano", symbol: "Bs" },
    currencies: [{ code: "BOB", name: "Boliviano", symbol: "Bs" }],
    capital: "Sucre", callingCode: "+591", region: "Americas", subregion: "South America",
    cities: ["Santa Cruz de la Sierra", "La Paz", "Cochabamba", "Sucre", "Oruro", "Tarija", "Potosí", "Trinidad", "El Alto", "Sacaba", "Quillacollo", "Riberalta", "Yacuiba", "Montero", "Camiri", "Warnes", "Cobija", "Viacha"],
  },
  {
    code: "DO", code3: "DOM", name: "Dominican Republic", officialName: "Dominican Republic",
    flag: "🇩🇴", currency: { code: "DOP", name: "Peso", symbol: "$" },
    currencies: [{ code: "DOP", name: "Peso", symbol: "$" }],
    capital: "Santo Domingo", callingCode: "+1-809", region: "Americas", subregion: "Caribbean",
    cities: ["Santo Domingo", "Santiago", "Santo Domingo Oeste", "Santo Domingo Este", "Los Alcarrizos", "San Cristóbal", "La Romana", "San Pedro de Macorís", "Higüey", "Puerto Plata", "San Juan de la Maguana", "Boca Chica", "Bonao", "Barahona", "Moca", "Azua", "Sánchez", "Samaná"],
  },
  {
    code: "CR", code3: "CRI", name: "Costa Rica", officialName: "Republic of Costa Rica",
    flag: "🇨🇷", currency: { code: "CRC", name: "Colón", symbol: "₡" },
    currencies: [{ code: "CRC", name: "Colón", symbol: "₡" }],
    capital: "San José", callingCode: "+506", region: "Americas", subregion: "Central America",
    cities: ["San José", "Puerto Limón", "Alajuela", "Heredia", "Cartago", "Puntarenas", "Liberia", "San Isidro de El General", "Paraíso", "Turrialba", "San Vicente", "San Francisco", "Quesada", "San Pablo", "Lipcira", "Guápiles", "San Ramón", "Orotina"],
  },
  {
    code: "PA", code3: "PAN", name: "Panama", officialName: "Republic of Panama",
    flag: "🇵🇦", currency: { code: "PAB", name: "Balboa", symbol: "B/." },
    currencies: [{ code: "PAB", name: "Balboa", symbol: "B/." }, { code: "USD", name: "Dollar", symbol: "$" }],
    capital: "Panama City", callingCode: "+507", region: "Americas", subregion: "Central America",
    cities: ["Panama City", "San Miguelito", "Colón", "David", "La Chorrera", "Arraiján", "Chitré", "Santiago", "Aguadulce", "Bocas del Toro", "Las Tablas", "Penonomé", "Changuinola", "Vacamonte", "Chepo", "Puerto Armuelles", "Pacora", "Santa Ana"],
  },
  {
    code: "GT", code3: "GTM", name: "Guatemala", officialName: "Republic of Guatemala",
    flag: "🇬🇹", currency: { code: "GTQ", name: "Quetzal", symbol: "Q" },
    currencies: [{ code: "GTQ", name: "Quetzal", symbol: "Q" }],
    capital: "Guatemala City", callingCode: "+502", region: "Americas", subregion: "Central America",
    cities: ["Guatemala City", "Mixco", "Villa Nueva", "Quetzaltenango", "San Miguel Petapa", "Escuintla", "San Juan Sacatepéquez", "Villa Canales", "Chimaltenango", "Amatitlán", "Huehuetenango", "Santa Lucía Cotzumalguapa", "Puerto Barrios", "Cobán", "Chichicastenango", "Salamá", "Jalapa", "Mazatenango"],
  },
  {
    code: "JM", code3: "JAM", name: "Jamaica", officialName: "Jamaica",
    flag: "🇯🇲", currency: { code: "JMD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "JMD", name: "Dollar", symbol: "$" }],
    capital: "Kingston", callingCode: "+1-876", region: "Americas", subregion: "Caribbean",
    cities: ["Kingston", "Portmore", "Spanish Town", "Montego Bay", "May Pen", "Mandeville", "Old Harbour", "Savanna-la-Mar", "Ocho Ríos", "Linstead", "Port Antonio", "Brown's Town", "Annotto Bay", "Black River", "Falmouth", "Morant Bay", "Saint Ann's Bay", "Lucea"],
  },
  {
    code: "JO", code3: "JOR", name: "Jordan", officialName: "Hashemite Kingdom of Jordan",
    flag: "🇯🇴", currency: { code: "JOD", name: "Dinar", symbol: "د.ا" },
    currencies: [{ code: "JOD", name: "Dinar", symbol: "د.ا" }],
    capital: "Amman", callingCode: "+962", region: "Asia", subregion: "Western Asia",
    cities: ["Amman", "Zarqa", "Irbid", "Russeifa", "Salt", "Aqaba", "Madaba", "Karak", "Jerash", "Ma'an", "Mafraq", "Ajloun", "Ramtha", "Tafilah", "As-Salt", "Wadi Musa", "Sahab", "Dhiban"],
  },
  {
    code: "LB", code3: "LBN", name: "Lebanon", officialName: "Lebanese Republic",
    flag: "🇱🇧", currency: { code: "LBP", name: "Pound", symbol: "ل.ل" },
    currencies: [{ code: "LBP", name: "Pound", symbol: "ل.ل" }],
    capital: "Beirut", callingCode: "+961", region: "Asia", subregion: "Western Asia",
    cities: ["Beirut", "Tripoli", "Sidon", "Tyre", "Nabatieh", "Zahle", "Baabda", "Jounieh", "Batroun", "Byblos", "Bcharre", "Aley", "Baakline", "Chtoura", "Baalbek", "Hermel", "Rashaya", "Jezzine"],
  },
  {
    code: "BH", code3: "BHR", name: "Bahrain", officialName: "Kingdom of Bahrain",
    flag: "🇧🇭", currency: { code: "BHD", name: "Dinar", symbol: "د.ب" },
    currencies: [{ code: "BHD", name: "Dinar", symbol: "د.ب" }],
    capital: "Manama", callingCode: "+973", region: "Asia", subregion: "Western Asia",
    cities: ["Manama", "Riffa", "Muharraq", "Hamad Town", "Isa Town", "Budaiya", "Jidhafs", "Sanabis", "Tubli", "Sitra", "Juffair", "Adliya", "Seef", "Bilad Al Qadeem", "Diyar Al Muharraq", "Amwaj Islands", "Zallaq", "Buri"],
  },
  {
    code: "YE", code3: "YEM", name: "Yemen", officialName: "Republic of Yemen",
    flag: "🇾🇪", currency: { code: "YER", name: "Rial", symbol: "﷼" },
    currencies: [{ code: "YER", name: "Rial", symbol: "﷼" }],
    capital: "Sanaa", callingCode: "+967", region: "Asia", subregion: "Western Asia",
    cities: ["Sanaa", "Aden", "Taiz", "Hodeidah", "Mukalla", "Ibb", "Dhamar", "Amran", "Saada", "Bajil", "Zabid", "Bayhan", "Mocha", "Ataq", "Tarim", "Shibam", "Saywun", "Seiyun"],
  },
  {
    code: "SY", code3: "SYR", name: "Syria", officialName: "Syrian Arab Republic",
    flag: "🇸🇾", currency: { code: "SYP", name: "Pound", symbol: "£" },
    currencies: [{ code: "SYP", name: "Pound", symbol: "£" }],
    capital: "Damascus", callingCode: "+963", region: "Asia", subregion: "Western Asia",
    cities: ["Damascus", "Aleppo", "Homs", "Latakia", "Hama", "Raqqa", "Deir ez-Zor", "Hasakah", "Qamishli", "Idlib", "Daraa", "Tartus", "Suwayda", "As-Suwayda", "Al-Hasakah", "Manbij", "Talkalakh", "Palmyra"],
  },
  {
    code: "PS", code3: "PSE", name: "Palestine", officialName: "State of Palestine",
    flag: "🇵🇸", currency: { code: "ILS", name: "Shekel", symbol: "₪" },
    currencies: [{ code: "ILS", name: "Shekel", symbol: "₪" }],
    capital: "East Jerusalem", callingCode: "+970", region: "Asia", subregion: "Western Asia",
    cities: ["Gaza", "Khan Yunis", "Rafah", "Nablus", "Hebron", "Bethlehem", "Jenin", "Tulkarm", "Qalqilya", "Ramallah", "Jericho", "Salfit", "Tubas", "Dura", "Yatta", "Beit Lahia", "Beit Hanoun", "Deir al-Balah"],
  },
  {
    code: "IL", code3: "ISR", name: "Israel", officialName: "State of Israel",
    flag: "🇮🇱", currency: { code: "ILS", name: "Shekel", symbol: "₪" },
    currencies: [{ code: "ILS", name: "Shekel", symbol: "₪" }],
    capital: "Jerusalem", callingCode: "+972", region: "Asia", subregion: "Western Asia",
    cities: ["Jerusalem", "Tel Aviv", "Haifa", "Rishon LeZion", "Petah Tikva", "Ashdod", "Netanya", "Beersheba", "Bnei Brak", "Holon", "Ramat Gan", "Ashkelon", "Rehovot", "Bat Yam", "Beit Shemesh", "Kfar Saba", "Herzliya", "Hadera"],
  },
  {
    code: "BY", code3: "BLR", name: "Belarus", officialName: "Republic of Belarus",
    flag: "🇧🇾", currency: { code: "BYN", name: "Ruble", symbol: "Br" },
    currencies: [{ code: "BYN", name: "Ruble", symbol: "Br" }],
    capital: "Minsk", callingCode: "+375", region: "Europe", subregion: "Eastern Europe",
    cities: ["Minsk", "Gomel", "Mogilev", "Vitebsk", "Hrodna", "Brest", "Babruysk", "Baranavichy", "Barysau", "Pinsk", "Orsha", "Mazyr", "Salihorsk", "Navapolatsk", "Lida", "Polatsk", "Maladzyechna", "Zhlobin"],
  },
  {
    code: "MD", code3: "MDA", name: "Moldova", officialName: "Republic of Moldova",
    flag: "🇲🇩", currency: { code: "MDL", name: "Leu", symbol: "L" },
    currencies: [{ code: "MDL", name: "Leu", symbol: "L" }],
    capital: "Chișinău", callingCode: "+373", region: "Europe", subregion: "Eastern Europe",
    cities: ["Chișinău", "Tiraspol", "Bălți", "Bender", "Rîbnița", "Cahul", "Ungheni", "Soroca", "Orhei", "Dubăsari", "Comrat", "Căușeni", "Strășeni", "Fălești", "Sângerei", "Edinet", "Cimișlia", "Hîncești"],
  },
  {
    code: "GE", code3: "GEO", name: "Georgia", officialName: "Georgia",
    flag: "🇬🇪", currency: { code: "GEL", name: "Lari", symbol: "₾" },
    currencies: [{ code: "GEL", name: "Lari", symbol: "₾" }],
    capital: "Tbilisi", callingCode: "+995", region: "Asia", subregion: "Western Asia",
    cities: ["Tbilisi", "Batumi", "Kutaisi", "Rustavi", "Zugdidi", "Gori", "Poti", "Khashuri", "Samtredia", "Senaki", "Zestafoni", "Marneuli", "Telavi", "Akhaltsikhe", "Ozurgeti", "Mtskheta", "Kobuleti", "Tsqaltubo"],
  },
  {
    code: "AM", code3: "ARM", name: "Armenia", officialName: "Republic of Armenia",
    flag: "🇦🇲", currency: { code: "AMD", name: "Dram", symbol: "֏" },
    currencies: [{ code: "AMD", name: "Dram", symbol: "֏" }],
    capital: "Yerevan", callingCode: "+374", region: "Asia", subregion: "Western Asia",
    cities: ["Yerevan", "Gyumri", "Vanadzor", "Vagharshapat", "Hrazdan", "Abovyan", "Kapan", "Armavir", "Ararat", "Gavar", "Goris", "Charentsavan", "Sevan", "Artashat", "Ashtarak", "Ijevan", "Sisian", "Tashir"],
  },
  {
    code: "AZ", code3: "AZE", name: "Azerbaijan", officialName: "Republic of Azerbaijan",
    flag: "🇦🇿", currency: { code: "AZN", name: "Manat", symbol: "₼" },
    currencies: [{ code: "AZN", name: "Manat", symbol: "₼" }],
    capital: "Baku", callingCode: "+994", region: "Asia", subregion: "Western Asia",
    cities: ["Baku", "Ganja", "Sumqayit", "Mingachevir", "Lankaran", "Nakhchivan", "Shirvan", "Shamakhi", "Sheki", "Quba", "Khachmaz", "Yevlakh", "Jalilabad", "Agdash", "Tovuz", "Goychay", "Ujar", "Qabala"],
  },
  {
    code: "KZ", code3: "KAZ", name: "Kazakhstan", officialName: "Republic of Kazakhstan",
    flag: "🇰🇿", currency: { code: "KZT", name: "Tenge", symbol: "₸" },
    currencies: [{ code: "KZT", name: "Tenge", symbol: "₸" }],
    capital: "Astana", callingCode: "+7", region: "Asia", subregion: "Central Asia",
    cities: ["Almaty", "Astana", "Shymkent", "Karaganda", "Aktobe", "Taraz", "Pavlodar", "Oskemen", "Semey", "Atyrau", "Kostanay", "Kyzylorda", "Petropavl", "Aktau", "Temirtau", "Turkestan", "Taldykorgan", "Zhezkazgan"],
  },
  {
    code: "UZ", code3: "UZB", name: "Uzbekistan", officialName: "Republic of Uzbekistan",
    flag: "🇺🇿", currency: { code: "UZS", name: "Sum", symbol: "so'm" },
    currencies: [{ code: "UZS", name: "Sum", symbol: "so'm" }],
    capital: "Tashkent", callingCode: "+998", region: "Asia", subregion: "Central Asia",
    cities: ["Tashkent", "Namangan", "Samarkand", "Andijan", "Nukus", "Bukhara", "Qarshi", "Fergana", "Kokand", "Margilan", "Jizzakh", "Navoiy", "Termez", "Urgench", "Angren", "Chirchiq", "Olmaliq", "Yangiyer"],
  },
  {
    code: "TM", code3: "TKM", name: "Turkmenistan", officialName: "Turkmenistan",
    flag: "🇹🇲", currency: { code: "TMT", name: "Manat", symbol: "m" },
    currencies: [{ code: "TMT", name: "Manat", symbol: "m" }],
    capital: "Ashgabat", callingCode: "+993", region: "Asia", subregion: "Central Asia",
    cities: ["Ashgabat", "Turkmenabat", "Daşoguz", "Mary", "Turkmenbashi", "Balkanabat", "Tejen", "Köneürgenç", "Atamurat", "Yolöten", "Serdar", "Baharly", "Göktepe", "Gyzylarbat", "Gyzyletrek", "Abadan", "Belek", "Garabekewül"],
  },
  {
    code: "KG", code3: "KGZ", name: "Kyrgyzstan", officialName: "Kyrgyz Republic",
    flag: "🇰🇬", currency: { code: "KGS", name: "Som", symbol: "с" },
    currencies: [{ code: "KGS", name: "Som", symbol: "с" }],
    capital: "Bishkek", callingCode: "+996", region: "Asia", subregion: "Central Asia",
    cities: ["Bishkek", "Osh", "Jalal-Abad", "Karakol", "Tokmok", "Uzgen", "Balıkçı", "Kant", "Kara-Balta", "Naryn", "Talas", "Kyzyl-Kiya", "Kara-Suu", "Shopokov", "Mailuu-Suu", "Jumgal", "Kerben", "Isfana"],
  },
  {
    code: "TJ", code3: "TJK", name: "Tajikistan", officialName: "Republic of Tajikistan",
    flag: "🇹🇯", currency: { code: "TJS", name: "Somoni", symbol: "ЅМ" },
    currencies: [{ code: "TJS", name: "Somoni", symbol: "ЅМ" }],
    capital: "Dushanbe", callingCode: "+992", region: "Asia", subregion: "Central Asia",
    cities: ["Dushanbe", "Khujand", "Bokhtar", "Kulob", "Tursunzoda", "Istaravshan", "Konibodom", "Vahdat", "Penjikent", "Isfara", "Khorugh", "Roghun", "Yovon", "Norak", "Hisor", "Taboshar", "Vose", "Shahritus"],
  },
  {
    code: "AF", code3: "AFG", name: "Afghanistan", officialName: "Islamic Republic of Afghanistan",
    flag: "🇦🇫", currency: { code: "AFN", name: "Afghani", symbol: "؋" },
    currencies: [{ code: "AFN", name: "Afghani", symbol: "؋" }],
    capital: "Kabul", callingCode: "+93", region: "Asia", subregion: "Southern Asia",
    cities: ["Kabul", "Kandahar", "Herat", "Mazar-i-Sharif", "Kunduz", "Taloqan", "Puli Khumri", "Charikar", "Jalalabad", "Ghazni", "Bamyan", "Zaranj", "Farah", "Lashkar Gah", "Maymana", "Sheberghan", "Aybak", "Fayzabad"],
  },
  {
    code: "NP", code3: "NPL", name: "Nepal", officialName: "Federal Democratic Republic of Nepal",
    flag: "🇳🇵", currency: { code: "NPR", name: "Rupee", symbol: "₨" },
    currencies: [{ code: "NPR", name: "Rupee", symbol: "₨" }],
    capital: "Kathmandu", callingCode: "+977", region: "Asia", subregion: "Southern Asia",
    cities: ["Kathmandu", "Pokhara", "Lalitpur", "Bharatpur", "Birgunj", "Biratnagar", "Janakpur", "Hetauda", "Dharan", "Butwal", "Nepalgunj", "Bhaktapur", "Mahendranagar", "Itahari", "Tulsipur", "Gulariya", "Lahan", "Birendranagar"],
  },
  {
    code: "MM", code3: "MMR", name: "Myanmar", officialName: "Republic of the Union of Myanmar",
    flag: "🇲🇲", currency: { code: "MMK", name: "Kyat", symbol: "K" },
    currencies: [{ code: "MMK", name: "Kyat", symbol: "K" }],
    capital: "Naypyidaw", callingCode: "+95", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Yangon", "Mandalay", "Naypyidaw", "Mawlamyine", "Bago", "Pathein", "Monywa", "Sittwe", "Meiktila", "Myingyan", "Hinthada", "Pyay", "Hpa-An", "Dawei", "Lashio", "Pyin Oo Lwin", "Magway", "Taunggyi"],
  },
  {
    code: "KH", code3: "KHM", name: "Cambodia", officialName: "Kingdom of Cambodia",
    flag: "🇰🇭", currency: { code: "KHR", name: "Riel", symbol: "៛" },
    currencies: [{ code: "KHR", name: "Riel", symbol: "៛" }, { code: "USD", name: "Dollar", symbol: "$" }],
    capital: "Phnom Penh", callingCode: "+855", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Phnom Penh", "Battambang", "Siem Reap", "Sihanoukville", "Kampong Cham", "Poipet", "Pursat", "Kampong Chhnang", "Kampong Speu", "Takeo", "Kratié", "Stung Treng", "Banlung", "Kep", "Kampot", "Pailin", "Svay Rieng", "Samraong"],
  },
  {
    code: "LA", code3: "LAO", name: "Laos", officialName: "Lao People's Democratic Republic",
    flag: "🇱🇦", currency: { code: "LAK", name: "Kip", symbol: "₭" },
    currencies: [{ code: "LAK", name: "Kip", symbol: "₭" }],
    capital: "Vientiane", callingCode: "+856", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Vientiane", "Pakse", "Savannakhet", "Luang Prabang", "Thakhek", "Xam Neua", "Phonsavan", "Muang Xay", "Vang Vieng", "Salavan", "Sayaboury", "Attapeu", "Champasak", "Sekong", "Luang Namtha", "Bokeo", "Bolikhamsai", "Khammouane"],
  },
  {
    code: "BN", code3: "BRN", name: "Brunei", officialName: "Brunei Darussalam",
    flag: "🇧🇳", currency: { code: "BND", name: "Dollar", symbol: "$" },
    currencies: [{ code: "BND", name: "Dollar", symbol: "$" }],
    capital: "Bandar Seri Begawan", callingCode: "+673", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Bandar Seri Begawan", "Kuala Belait", "Seria", "Tutong", "Bangar", "Muara", "Jerudong", "Labi", "Sukang", "Melilas", "Rambai", "Telisai", "Pengkalan Batu", "Liang", "Sengkurong", "Bukit Beruang", "Pekan Bangar", "Kampong Pandan"],
  },
  {
    code: "ZW", code3: "ZWE", name: "Zimbabwe", officialName: "Republic of Zimbabwe",
    flag: "🇿🇼", currency: { code: "ZWL", name: "Dollar", symbol: "$" },
    currencies: [{ code: "ZWL", name: "Dollar", symbol: "$" }, { code: "USD", name: "Dollar", symbol: "$" }],
    capital: "Harare", callingCode: "+263", region: "Africa", subregion: "Eastern Africa",
    cities: ["Harare", "Bulawayo", "Chitungwiza", "Mutare", "Gweru", "Kwekwe", "Kadoma", "Masvingo", "Chinhoyi", "Marondera", "Bindura", "Beitbridge", "Redcliff", "Victoria Falls", "Rusape", "Chegutu", "Gwanda", "Hwange"],
  },
  {
    code: "ZM", code3: "ZMB", name: "Zambia", officialName: "Republic of Zambia",
    flag: "🇿🇲", currency: { code: "ZMW", name: "Kwacha", symbol: "ZK" },
    currencies: [{ code: "ZMW", name: "Kwacha", symbol: "ZK" }],
    capital: "Lusaka", callingCode: "+260", region: "Africa", subregion: "Eastern Africa",
    cities: ["Lusaka", "Kitwe", "Ndola", "Kabwe", "Chingola", "Mufulira", "Livingstone", "Luanshya", "Kasama", "Chipata", "Solwezi", "Mazabuka", "Chililabombwe", "Siavonga", "Mongu", "Sesheke", "Kapiri Mposhi", "Mansa"],
  },
  {
    code: "AO", code3: "AGO", name: "Angola", officialName: "Republic of Angola",
    flag: "🇦🇴", currency: { code: "AOA", name: "Kwanza", symbol: "Kz" },
    currencies: [{ code: "AOA", name: "Kwanza", symbol: "Kz" }],
    capital: "Luanda", callingCode: "+244", region: "Africa", subregion: "Middle Africa",
    cities: ["Luanda", "Huambo", "Benguela", "Lobito", "Lucapa", "Malanje", "Namibe", "Sumbe", "Cabinda", "Uíge", "Saurimo", "Caxito", "M'banza-Kongo", "N'dalatando", "Menongue", "Lubango", "Ondjiva", "Luena"],
  },
  {
    code: "MZ", code3: "MOZ", name: "Mozambique", officialName: "Republic of Mozambique",
    flag: "🇲🇿", currency: { code: "MZN", name: "Metical", symbol: "MT" },
    currencies: [{ code: "MZN", name: "Metical", symbol: "MT" }],
    capital: "Maputo", callingCode: "+258", region: "Africa", subregion: "Eastern Africa",
    cities: ["Maputo", "Matola", "Nampula", "Beira", "Chimoio", "Quelimane", "Tete", "Lichinga", "Pemba", "Xai-Xai", "Gurué", "Inhambane", "Dondo", "Maxixe", "Cuamba", "Montepuez", "Mocuba", "António Enes"],
  },
  {
    code: "CM", code3: "CMR", name: "Cameroon", officialName: "Republic of Cameroon",
    flag: "🇨🇲", currency: { code: "XAF", name: "CFA Franc", symbol: "₣" },
    currencies: [{ code: "XAF", name: "CFA Franc", symbol: "₣" }],
    capital: "Yaoundé", callingCode: "+237", region: "Africa", subregion: "Middle Africa",
    cities: ["Douala", "Yaoundé", "Bamenda", "Bafoussam", "Garoua", "Maroua", "Ngaoundéré", "Kumba", "Buea", "Limbe", "Ebolowa", "Bertoua", "Kribi", "Loum", "Foumban", "Dschang", "Tiko", "Mbouda"],
  },
  {
    code: "UG", code3: "UGA", name: "Uganda", officialName: "Republic of Uganda",
    flag: "🇺🇬", currency: { code: "UGX", name: "Shilling", symbol: "USh" },
    currencies: [{ code: "UGX", name: "Shilling", symbol: "USh" }],
    capital: "Kampala", callingCode: "+256", region: "Africa", subregion: "Eastern Africa",
    cities: ["Kampala", "Wakiso", "Mukono", "Mbarara", "Lugazi", "Jinja", "Gulu", "Mbale", "Mityana", "Masaka", "Entebbe", "Njeru", "Kasese", "Hoima", "Soroti", "Lira", "Tororo", "Kabale"],
  },
  {
    code: "RW", code3: "RWA", name: "Rwanda", officialName: "Republic of Rwanda",
    flag: "🇷🇼", currency: { code: "RWF", name: "Franc", symbol: "₣" },
    currencies: [{ code: "RWF", name: "Franc", symbol: "₣" }],
    capital: "Kigali", callingCode: "+250", region: "Africa", subregion: "Eastern Africa",
    cities: ["Kigali", "Butare", "Gitarama", "Ruhengeri", "Gisenyi", "Byumba", "Cyangugu", "Kibuye", "Rwamagana", "Kibungo", "Gikongoro", "Nyanza", "Musanze", "Nyamata", "Kayonza", "Karongi", "Rusizi", "Muhanga"],
  },
  {
    code: "MZ", code3: "MOZ", name: "Mozambique", officialName: "Republic of Mozambique",
    flag: "🇲🇿", currency: { code: "MZN", name: "Metical", symbol: "MT" },
    currencies: [{ code: "MZN", name: "Metical", symbol: "MT" }],
    capital: "Maputo", callingCode: "+258", region: "Africa", subregion: "Eastern Africa",
    cities: ["Maputo", "Matola", "Nampula", "Beira", "Chimoio", "Quelimane", "Tete", "Lichinga", "Pemba", "Xai-Xai", "Gurué", "Inhambane", "Dondo", "Maxixe", "Cuamba", "Montepuez", "Mocuba", "António Enes"],
  },
  {
    code: "SG", code3: "SGP", name: "Singapore", officialName: "Republic of Singapore",
    flag: "🇸🇬", currency: { code: "SGD", name: "Dollar", symbol: "$" },
    currencies: [{ code: "SGD", name: "Dollar", symbol: "$" }],
    capital: "Singapore", callingCode: "+65", region: "Asia", subregion: "South-Eastern Asia",
    cities: ["Singapore", "Jurong", "Tampines", "Woodlands", "Bedok", "Sengkang", "Hougang", "Yishun", "Choa Chu Kang", "Ang Mo Kio", "Bukit Batok", "Bukit Merah", "Toa Payoh", "Geylang", "Kallang", "Pasir Ris", "Punggol", "Queenstown"],
  },
  {
    code: "PS", code3: "PSE", name: "Palestine", officialName: "State of Palestine",
    flag: "🇵🇸", currency: { code: "ILS", name: "Shekel", symbol: "₪" },
    currencies: [{ code: "ILS", name: "Shekel", symbol: "₪" }],
    capital: "East Jerusalem", callingCode: "+970", region: "Asia", subregion: "Western Asia",
    cities: ["Gaza", "Khan Yunis", "Rafah", "Nablus", "Hebron", "Bethlehem", "Jenin", "Tulkarm", "Qalqilya", "Ramallah", "Jericho", "Salfit", "Tubas", "Dura", "Yatta", "Beit Lahia", "Beit Hanoun", "Deir al-Balah"],
  },
  {
    code: "PS", code3: "PSE", name: "Palestine", officialName: "State of Palestine",
    flag: "🇵🇸", currency: { code: "ILS", name: "Shekel", symbol: "₪" },
    currencies: [{ code: "ILS", name: "Shekel", symbol: "₪" }],
    capital: "East Jerusalem", callingCode: "+970", region: "Asia", subregion: "Western Asia",
    cities: ["Gaza", "Khan Yunis", "Rafah", "Nablus", "Hebron", "Bethlehem", "Jenin", "Tulkarm", "Qalqilya", "Ramallah", "Jericho", "Salfit", "Tubas", "Dura", "Yatta", "Beit Lahia", "Beit Hanoun", "Deir al-Balah"],
  },
  {
    code: "ES", code3: "ESP", name: "Spain", officialName: "Kingdom of Spain",
    flag: "🇪🇸", currency: { code: "EUR", name: "Euro", symbol: "€" },
    currencies: [{ code: "EUR", name: "Euro", symbol: "€" }],
    capital: "Madrid", callingCode: "+34", region: "Europe", subregion: "Southern Europe",
    cities: ["Madrid", "Barcelona", "Valencia", "Seville", "Zaragoza", "Málaga", "Murcia", "Palma", "Bilbao", "Alicante", "Córdoba", "Valladolid", "Vigo", "Gijón", "Granada", "Elche", "Oviedo", "Badalona"],
  },
];

// Remove duplicates (by ISO alpha-2 code) then sort by name
const _seen = new Set<string>();
const _unique: Country[] = [];
for (const c of _raw) {
  if (!_seen.has(c.code)) {
    _seen.add(c.code);
    _unique.push(c);
  }
}
export const COUNTRIES = _unique.sort((a, b) => a.name.localeCompare(b.name));

/**
 * Get a country by its ISO alpha-2 code.
 */
export function getCountry(code: string): Country | null {
  return COUNTRIES.find((c) => c.code === code.toUpperCase()) || null;
}

/**
 * Get cities for a given country code.
 */
export function getCities(countryCode: string): string[] {
  const country = getCountry(countryCode);
  return country?.cities || [];
}

/**
 * Get all countries as a flat list for SearchableSelect.
 */
export function getCountriesForSelect(): Array<{
  value: string;
  label: string;
  icon: string;
  description: string;
}> {
  return COUNTRIES.map((c) => ({
    value: c.code,
    label: c.name,
    icon: c.flag,
    description: `${c.capital} · ${c.currency.code} · ${c.callingCode}`,
  }));
}

/**
 * Get cities for a country as a flat list for SearchableSelect.
 */
export function getCitiesForSelect(countryCode: string): Array<{
  value: string;
  label: string;
}> {
  return getCities(countryCode).map((city) => ({
    value: city,
    label: city,
  }));
}
