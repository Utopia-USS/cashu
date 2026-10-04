"""Category taxonomy and Polish merchant seed-rule set.

Transactions are normalized to a ``merchant_key`` that is UPPERCASE, has
diacritics stripped (ł->L, ż->Z, ą->A, ...), and has whitespace collapsed.
Seed rules match by plain uppercase substring against that key.

The sign of the amount (income vs. expense) is handled by the engine, not
here. Income rules are therefore kept intentionally minimal.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Category:
    key: str      # stable id, one of the keys below
    label: str    # Polish display label
    kind: str     # "expense" | "income" | "transfer"


# Use EXACTLY these keys (order = display order):
CATEGORIES: list[Category] = [
    Category("groceries", "Spożywcze", "expense"),
    Category("dining", "Gastronomia", "expense"),
    Category("transport", "Transport", "expense"),
    Category("fuel", "Paliwo", "expense"),
    Category("car", "Auto", "expense"),
    Category("housing", "Mieszkanie/Czynsz", "expense"),
    # Loan / mortgage / leasing installments (phrases registered by the loans module).
    Category("loans", "Raty kredytów", "expense"),
    Category("utilities", "Media/Telekom", "expense"),
    Category("health", "Zdrowie/Apteka", "expense"),
    Category("shopping", "Zakupy", "expense"),
    Category("entertainment", "Rozrywka", "expense"),
    Category("subscriptions", "Subskrypcje", "expense"),
    Category("travel", "Podróże", "expense"),
    Category("education", "Edukacja", "expense"),
    Category("personal_care", "Higiena/Uroda", "expense"),
    Category("gifts", "Prezenty/Darowizny", "expense"),
    Category("cash", "Gotówka", "expense"),
    Category("fees", "Opłaty bankowe", "expense"),
    Category("taxes", "Podatki", "expense"),
    Category("other", "Inne", "expense"),
    Category("income_salary", "Pensja", "income"),
    Category("income_refund", "Zwroty", "income"),
    Category("income_other", "Inne przychody", "income"),
    Category("transfer", "Przelew własny", "transfer"),
    # A bank withdrawal reclassified as a move into the physical-cash pool.
    # Transfer-kind: never counted as spend/income; feeds the CASH account.
    Category("cash_withdrawal", "Wypłata gotówki", "transfer"),
]

CATEGORY_KEYS: list[str] = [c.key for c in CATEGORIES]
LABELS: dict[str, str] = {c.key: c.label for c in CATEGORIES}

# Ordered, first-match-wins. Each tuple: (UPPERCASE substring, category_key).
# Substrings are already uppercase + diacritics-stripped to match merchant_key.
#
# ORDER MATTERS. More specific patterns must come before generic ones, e.g.
# "UBER EATS"/"UBER *EATS" (dining) must precede the generic "UBER"
# (transport), and "BOLT FOOD" (dining) must precede "BOLT" (transport).
SEED_RULES: list[tuple[str, str]] = [
    # ------------------------------------------------------------------
    # Collision guards: food-delivery arms of ride/transport brands.
    # These MUST come before the generic UBER / BOLT transport rules.
    # ------------------------------------------------------------------
    ("UBER EATS", "dining"),
    ("UBER *EATS", "dining"),
    ("UBEREATS", "dining"),
    ("BOLT FOOD", "dining"),
    ("BOLT.FOOD", "dining"),
    ("BOLTFOOD", "dining"),

    # ------------------------------------------------------------------
    # Subscriptions / digital services (specific brands first).
    # Aggregator prefixes like "PP*", "PAYPAL *" still match via substring.
    # ------------------------------------------------------------------
    ("NETFLIX", "subscriptions"),
    ("SPOTIFY", "subscriptions"),
    ("GOOGLE YOUTUBE", "subscriptions"),
    ("YOUTUBEPREMIUM", "subscriptions"),
    ("YOUTUBE", "subscriptions"),
    ("GOOGLE PLAY", "subscriptions"),
    ("GOOGLE STORAGE", "subscriptions"),
    ("GOOGLE ONE", "subscriptions"),
    ("GOOGLE *", "subscriptions"),
    ("GOOGLE", "subscriptions"),
    ("DISNEY", "subscriptions"),
    ("DISNEYPLUS", "subscriptions"),
    ("HBO MAX", "subscriptions"),
    ("HBOMAX", "subscriptions"),
    ("HBO", "subscriptions"),
    ("APPLE.COM", "subscriptions"),
    ("APPLE COM", "subscriptions"),
    ("ITUNES", "subscriptions"),
    ("PATREON", "subscriptions"),
    ("AMAZON PRIME", "subscriptions"),
    ("PRIME VIDEO", "subscriptions"),
    ("MICROSOFT 365", "subscriptions"),
    ("MICROSOFT*", "subscriptions"),
    ("MICROSOFT", "subscriptions"),
    ("XBOX", "subscriptions"),
    ("OPENAI", "subscriptions"),
    ("CHATGPT", "subscriptions"),
    ("ANTHROPIC", "subscriptions"),
    ("CLAUDE.AI", "subscriptions"),
    ("CANVA", "subscriptions"),
    ("ADOBE", "subscriptions"),
    ("DROPBOX", "subscriptions"),
    ("NOTION", "subscriptions"),
    ("GITHUB", "subscriptions"),
    ("LEGIMI", "subscriptions"),
    ("AUDIOTEKA", "subscriptions"),
    ("STORYTEL", "subscriptions"),
    ("EMPIK GO", "subscriptions"),
    ("PLAYER.PL", "subscriptions"),
    ("PLAYER", "subscriptions"),
    ("TVN", "subscriptions"),
    ("CANAL+", "subscriptions"),
    ("CANAL PLUS", "subscriptions"),
    ("POLSAT BOX", "subscriptions"),
    ("VIAPLAY", "subscriptions"),
    ("SKYSHOWTIME", "subscriptions"),
    ("TIDAL", "subscriptions"),
    ("DEEZER", "subscriptions"),
    ("TINDER", "subscriptions"),

    # ------------------------------------------------------------------
    # Utilities / telecom.
    # ------------------------------------------------------------------
    ("TAURON", "utilities"),
    ("PGE", "utilities"),
    ("PGNIG", "utilities"),
    ("PGNIG OBROT", "utilities"),
    ("ENEA", "utilities"),
    ("ENERGA", "utilities"),
    ("INNOGY", "utilities"),
    ("E.ON", "utilities"),
    ("EON", "utilities"),
    ("FORTUM", "utilities"),
    ("MPWIK", "utilities"),
    ("WODOCIAGI", "utilities"),
    ("WOD-KAN", "utilities"),
    ("WOD KAN", "utilities"),
    ("MPEC", "utilities"),
    ("PEC", "utilities"),
    ("NETIA", "utilities"),
    ("ORANGE", "utilities"),
    ("T-MOBILE", "utilities"),
    ("T MOBILE", "utilities"),
    ("TMOBILE", "utilities"),
    ("HEYAH", "utilities"),
    ("PLUS ", "utilities"),
    ("POLKOMTEL", "utilities"),
    ("PLAY ", "utilities"),
    ("P4 SP", "utilities"),
    ("UPC", "utilities"),
    ("VECTRA", "utilities"),
    ("INEA", "utilities"),
    ("MULTIMEDIA", "utilities"),
    ("TOYA", "utilities"),

    # ------------------------------------------------------------------
    # Housing / rent.
    # ------------------------------------------------------------------
    ("CZYNSZ", "housing"),
    ("WSPOLNOTA", "housing"),
    ("WSPOLNOTA MIESZKAN", "housing"),
    ("SPOLDZIELNIA MIESZKAN", "housing"),
    ("SPOLDZIELNIA", "housing"),
    ("NAJEM", "housing"),
    ("WYNAJEM", "housing"),
    ("ZARZAD NIERUCHOMOSCI", "housing"),

    # ------------------------------------------------------------------
    # Groceries — big chains and neighbourhood shops.
    # ------------------------------------------------------------------
    ("BIEDRONKA", "groceries"),
    ("JERONIMO MARTINS", "groceries"),
    ("LIDL", "groceries"),
    ("KAUFLAND", "groceries"),
    ("CARREFOUR", "groceries"),
    ("AUCHAN", "groceries"),
    ("ZABKA", "groceries"),
    ("FRESHMARKET", "groceries"),
    ("FRESH MARKET", "groceries"),
    ("DINO", "groceries"),
    ("NETTO", "groceries"),
    ("STOKROTKA", "groceries"),
    ("ALDI", "groceries"),
    ("POLOMARKET", "groceries"),
    ("POLO MARKET", "groceries"),
    ("SELGROS", "groceries"),
    ("MAKRO", "groceries"),
    ("SPOLEM", "groceries"),
    ("LEWIATAN", "groceries"),
    ("TESCO", "groceries"),
    ("INTERMARCHE", "groceries"),
    ("PIOTR I PAWEL", "groceries"),
    ("DELIKATESY", "groceries"),
    ("ABC ", "groceries"),
    ("GROSZEK", "groceries"),
    ("CHATA POLSKA", "groceries"),
    ("TOPAZ", "groceries"),
    ("KUChNIA", "groceries"),
    ("PIEKARNIA", "groceries"),
    ("CUKIERNIA", "groceries"),
    ("WARZYWA", "groceries"),
    ("OWOCE", "groceries"),
    ("MIESO", "groceries"),
    ("SKLEP SPOZYWCZY", "groceries"),
    ("MARKET", "groceries"),

    # ------------------------------------------------------------------
    # Fuel stations.
    # ------------------------------------------------------------------
    ("ORLEN", "fuel"),
    ("BP ", "fuel"),
    ("BP-", "fuel"),
    ("SHELL", "fuel"),
    ("CIRCLE K", "fuel"),
    ("CIRCLEK", "fuel"),
    ("STATOIL", "fuel"),
    ("MOYA", "fuel"),
    ("AMIC", "fuel"),
    ("LOTOS", "fuel"),
    ("AVIA", "fuel"),
    ("STACJA PALIW", "fuel"),
    ("PALIWO", "fuel"),
    ("STACJA NR", "fuel"),

    # ------------------------------------------------------------------
    # Dining / cafes / food delivery.
    # ------------------------------------------------------------------
    ("MCDONALD", "dining"),
    ("KFC", "dining"),
    ("BURGER KING", "dining"),
    ("BURGERKING", "dining"),
    ("PIZZA", "dining"),
    ("PIZZERIA", "dining"),
    ("DOMINO", "dining"),
    ("TELEPIZZA", "dining"),
    ("KEBAB", "dining"),
    ("SUBWAY", "dining"),
    ("STARBUCKS", "dining"),
    ("COSTA COFFEE", "dining"),
    ("COFFEE", "dining"),
    ("KAWIARNIA", "dining"),
    ("CAFE", "dining"),
    ("PIJALNIA", "dining"),
    ("RESTAURACJA", "dining"),
    ("RESTAURANT", "dining"),
    ("BISTRO", "dining"),
    ("BAR MLECZNY", "dining"),
    ("SUSHI", "dining"),
    ("THAI", "dining"),
    ("SEPHORA", "shopping"),  # must precede "PHO" (a substring of SEPHORA)
    ("PHO", "dining"),
    ("BROWA", "dining"),       # e.g. "PIWO SWIEZE Z BROWA..."
    ("BROWAR", "dining"),
    ("PUB ", "dining"),
    ("PYSZNE", "dining"),
    ("PYSZNE.PL", "dining"),
    ("GLOVO", "dining"),
    ("WOLT", "dining"),
    ("GOOD LOOD", "dining"),   # ice cream, treat as dining
    ("LODY", "dining"),
    ("LODZIARNIA", "dining"),

    # ------------------------------------------------------------------
    # Transport (generic UBER / BOLT come AFTER their food arms above).
    # ------------------------------------------------------------------
    ("UBER", "transport"),
    ("BOLT", "transport"),
    ("FREENOW", "transport"),
    ("FREE NOW", "transport"),
    ("MPK", "transport"),
    ("ZTM", "transport"),
    ("ZTP", "transport"),
    ("ZDMIKP", "transport"),
    ("PKP", "transport"),
    ("INTERCITY", "transport"),
    ("PKP IC", "transport"),
    ("KOLEJE", "transport"),
    ("POLREGIO", "transport"),
    ("KOLEO", "transport"),
    ("JAKDOJADE", "transport"),
    ("MOBILET", "transport"),
    ("SKYCASH", "transport"),
    ("MPAY", "transport"),
    ("PARKING", "transport"),
    ("PARKOMAT", "transport"),
    ("AUTOPAY", "transport"),
    ("VIATOLL", "transport"),
    ("E-TOLL", "transport"),
    ("ETOLL", "transport"),
    ("TRAFICAR", "transport"),
    ("PANEK", "transport"),
    ("VOZILLA", "transport"),
    ("FLIXBUS", "transport"),
    ("VETURILO", "transport"),
    ("NEXTBIKE", "transport"),

    # ------------------------------------------------------------------
    # Car / vehicle service (not fuel).
    # ------------------------------------------------------------------
    ("WARSZTAT SAMOCHOD", "car"),
    ("MECHANIK", "car"),
    ("SERWIS SAMOCHOD", "car"),
    ("AUTO SERWIS", "car"),
    ("AUTOSERWIS", "car"),
    ("WULKANIZACJA", "car"),
    ("OPONY", "car"),
    ("MYJNIA", "car"),
    ("CZESCI SAMOCHOD", "car"),
    ("INTER CARS", "car"),
    ("STACJA KONTROLI POJAZD", "car"),
    ("PRZEGLAD", "car"),

    # ------------------------------------------------------------------
    # Health / pharmacy / clinics.
    # ------------------------------------------------------------------
    ("APTEKA", "health"),
    ("DOZ.PL", "health"),
    ("DOZ ", "health"),
    ("SUPER-PHARM", "health"),
    ("SUPERPHARM", "health"),
    ("GEMINI", "health"),
    ("MEDICOVER", "health"),
    ("LUXMED", "health"),
    ("LUX MED", "health"),
    ("ENEL-MED", "health"),
    ("ENEL MED", "health"),
    ("DIAGNOSTYKA", "health"),
    ("SYNEVO", "health"),
    ("ALAB", "health"),
    ("PRZYCHODNIA", "health"),
    ("PRZYCHODNIA LEKARSKA", "health"),
    ("PORADNIA", "health"),
    ("SZPITAL", "health"),
    ("STOMATOLOG", "health"),
    ("DENTYSTA", "health"),
    ("GABINET LEKARSKI", "health"),
    ("OPTYK", "health"),
    ("LEKARZ", "health"),

    # ------------------------------------------------------------------
    # Personal care / beauty / fitness.
    # ------------------------------------------------------------------
    ("MY FITNESS", "personal_care"),
    ("FITNESS", "personal_care"),
    ("SALON FRYZJERSKI", "personal_care"),
    ("FRYZJER", "personal_care"),
    ("BARBER", "personal_care"),
    ("SALON URODY", "personal_care"),
    ("KOSMETY", "personal_care"),
    ("MANICURE", "personal_care"),
    ("PAZNOKCIE", "personal_care"),
    ("SPA", "personal_care"),
    ("SOLARIUM", "personal_care"),
    ("SILOWNIA", "personal_care"),
    ("MCFIT", "personal_care"),
    ("XTREME FITNESS", "personal_care"),
    ("ZDROFIT", "personal_care"),
    ("CALYPSO", "personal_care"),

    # ------------------------------------------------------------------
    # Shopping / retail / marketplaces / lockers.
    # ------------------------------------------------------------------
    ("ALLEGRO", "shopping"),
    ("AMAZON", "shopping"),
    ("ZALANDO", "shopping"),
    ("MEDIA MARKT", "shopping"),
    ("MEDIAMARKT", "shopping"),
    ("MEDIA EXPERT", "shopping"),
    ("MEDIAEXPERT", "shopping"),
    ("RTV EURO", "shopping"),
    ("EURO RTV", "shopping"),
    ("X-KOM", "shopping"),
    ("XKOM", "shopping"),
    ("MORELE", "shopping"),
    ("KOMPUTRONIK", "shopping"),
    ("IKEA", "shopping"),
    ("LEROY", "shopping"),
    ("LEROY MERLIN", "shopping"),
    ("CASTORAMA", "shopping"),
    ("OBI ", "shopping"),
    ("BRICOMAN", "shopping"),
    ("JYSK", "shopping"),
    ("AGATA MEBLE", "shopping"),
    ("EMPIK", "shopping"),
    ("ROSSMANN", "shopping"),
    ("HEBE", "shopping"),
    ("DOUGLAS", "shopping"),
    ("SINSAY", "shopping"),
    ("RESERVED", "shopping"),
    ("CROPP", "shopping"),
    ("HOUSE ", "shopping"),
    ("MOHITO", "shopping"),
    ("ZARA", "shopping"),
    ("H&M", "shopping"),
    ("H & M", "shopping"),
    ("HM.COM", "shopping"),
    ("CCC", "shopping"),
    ("DEICHMANN", "shopping"),
    ("HALFPRICE", "shopping"),
    ("TK MAXX", "shopping"),
    ("DECATHLON", "shopping"),
    ("MARTES SPORT", "shopping"),
    ("GO SPORT", "shopping"),
    ("PEPCO", "shopping"),
    ("ACTION", "shopping"),
    ("KIK ", "shopping"),
    ("DEALZ", "shopping"),
    ("TEMU", "shopping"),
    ("SHEIN", "shopping"),
    ("ALIEXPRESS", "shopping"),
    ("EBAY", "shopping"),
    ("VINTED", "shopping"),
    ("SMYK", "shopping"),
    ("TOYS", "shopping"),
    ("ZOO KARINA", "shopping"),
    ("KAKADU", "shopping"),
    ("MAXI ZOO", "shopping"),
    ("INPOST", "shopping"),
    ("PACZKOMAT", "shopping"),
    ("DPD", "shopping"),
    ("DHL", "shopping"),
    ("POCZTA POLSKA", "shopping"),
    ("KWIACIARNIA", "shopping"),

    # ------------------------------------------------------------------
    # Entertainment / leisure / events.
    # ------------------------------------------------------------------
    ("CINEMA CITY", "entertainment"),
    ("MULTIKINO", "entertainment"),
    ("HELIOS", "entertainment"),
    ("KINO", "entertainment"),
    ("STEAM", "entertainment"),
    ("STEAMGAMES", "entertainment"),
    ("PLAYSTATION", "entertainment"),
    ("NINTENDO", "entertainment"),
    ("EBILET", "entertainment"),
    ("TICKETMASTER", "entertainment"),
    ("BILETY", "entertainment"),
    ("GOING.", "entertainment"),
    ("KOMEDIA", "entertainment"),
    ("TEATR", "entertainment"),
    ("FILHARMONIA", "entertainment"),
    ("MUZEUM", "entertainment"),
    ("KREGIELNIA", "entertainment"),
    ("ESCAPE ROOM", "entertainment"),
    ("MULTISPORT", "entertainment"),
    ("BENEFIT SYSTEMS", "entertainment"),
    ("BENEFIT", "entertainment"),
    ("BASEN", "entertainment"),
    ("AQUAPARK", "entertainment"),

    # ------------------------------------------------------------------
    # Travel / accommodation / airlines.
    # ------------------------------------------------------------------
    ("BOOKING.COM", "travel"),
    ("BOOKING", "travel"),
    ("AIRBNB", "travel"),
    ("HOTEL", "travel"),
    ("HOSTEL", "travel"),
    ("LOT ", "travel"),
    ("PLL LOT", "travel"),
    ("RYANAIR", "travel"),
    ("WIZZAIR", "travel"),
    ("WIZZ AIR", "travel"),
    ("LUFTHANSA", "travel"),
    ("EASYJET", "travel"),
    ("EXPEDIA", "travel"),
    ("TRIVAGO", "travel"),
    ("ESKY", "travel"),
    ("BIURO PODROZY", "travel"),
    ("TUI ", "travel"),
    ("ITAKA", "travel"),
    ("RAINBOW", "travel"),

    # ------------------------------------------------------------------
    # Education.
    # ------------------------------------------------------------------
    ("UDEMY", "education"),
    ("COURSERA", "education"),
    ("DUOLINGO", "education"),
    ("SZKOLA JEZYK", "education"),
    ("JEZYKOWA", "education"),
    ("KURS", "education"),
    ("SZKOLENIE", "education"),
    ("UNIWERSYTET", "education"),
    ("POLITECHNIKA", "education"),
    ("AKADEMIA", "education"),
    ("PRZEDSZKOLE", "education"),
    ("ZLOBEK", "education"),
    ("KSIEGARNIA", "education"),

    # ------------------------------------------------------------------
    # Taxes / public levies.
    # ------------------------------------------------------------------
    ("URZAD SKARBOWY", "taxes"),
    ("US KRAKOW", "taxes"),
    ("ZUS", "taxes"),
    ("PODATEK", "taxes"),
    ("VAT-", "taxes"),
    ("PIT-", "taxes"),
    ("PIT ", "taxes"),
    ("URZAD MIASTA", "taxes"),
    ("URZAD GMINY", "taxes"),
    ("OPLATA SKARBOWA", "taxes"),

    # ------------------------------------------------------------------
    # Cash / ATM withdrawals.
    # ------------------------------------------------------------------
    ("BANKOMAT", "cash"),
    ("WYPLATA GOTOWKI", "cash"),
    ("WYPLATA W BANKOMACIE", "cash"),
    ("WYPLATA WYNAGRODZENIA", "income_salary"),  # salary; must precede the generic "WYPLATA"
    ("WYPLATA", "cash"),
    ("EURONET", "cash"),
    ("PLANET CASH", "cash"),
    ("PLANETCASH", "cash"),
    ("ATM ", "cash"),
    (" ATM", "cash"),

    # ------------------------------------------------------------------
    # Bank fees / charges.
    # ------------------------------------------------------------------
    ("OPLATA ZA KARTE", "fees"),
    ("OBSLUGA KARTY", "fees"),
    ("OPLATA MIESIECZNA", "fees"),
    ("PROWIZJA", "fees"),
    ("ODSETKI", "fees"),
    ("OPLATA", "fees"),

    # ------------------------------------------------------------------
    # Insurance — ambiguous, mapped to "other" (no dedicated category).
    # ------------------------------------------------------------------
    ("ERGO HESTIA", "other"),
    ("PZU", "other"),
    ("WARTA", "other"),
    ("ALLIANZ", "other"),
    ("AXA", "other"),
    ("UNIQA", "other"),
    ("GENERALI", "other"),
    ("LINK4", "other"),
    ("NATIONALE-NEDERLANDEN", "other"),
    ("UBEZPIECZENIE", "other"),

    # ------------------------------------------------------------------
    # Gifts / donations / charity.
    # ------------------------------------------------------------------
    ("WOSP", "gifts"),
    ("FUNDACJA", "gifts"),
    ("DAROWIZNA", "gifts"),
    ("ZBIORKA", "gifts"),
    ("ZRZUTKA", "gifts"),
    ("PATRONITE", "gifts"),
    ("CARITAS", "gifts"),
    ("PCK", "gifts"),

    # ------------------------------------------------------------------
    # Income (kept minimal; engine handles sign).
    # ------------------------------------------------------------------
    ("WYNAGRODZENIE", "income_salary"),
    ("PENSJA", "income_salary"),
    ("ZWROT", "income_refund"),
]


# Phrases matched against the WHOLE transaction text (title, description and
# counterparty), not only the merchant key: rent is usually paid to a person or a
# housing association whose name says nothing about it. Applied to outflows before
# the merchant seed rules and before the recurring ("subscription") signal. Keep
# them specific: they override the merchant. Uppercase, diacritics stripped (like
# merchant_key). Other modules add their own phrases through ``ModuleSpec.text_rules``
# (the loans module: installment phrases -> "loans"); those are checked first.
TEXT_RULES: list[tuple[str, str]] = [
    ("CZYNSZ", "housing"),
]


def all_text_rules() -> list[tuple[str, str]]:
    """Module-registered phrases first, then the budget's own."""
    from finanse.core import modules

    return [*modules.text_rules(), *TEXT_RULES]


def apply_text_rules(text: str) -> str | None:
    """Return the first text-rule category whose phrase occurs in `text`
    (already normalized: uppercase, no diacritics), else None."""
    if not text:
        return None
    for needle, cat in all_text_rules():
        if needle in text:
            return cat
    return None


def apply_seed_rules(merchant_key: str) -> str | None:
    """Return the first category key whose substring is in merchant_key, else None."""
    if not merchant_key:
        return None
    for needle, cat in SEED_RULES:
        if needle in merchant_key:
            return cat
    return None
