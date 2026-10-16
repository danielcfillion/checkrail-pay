/**
 * Does a piece of text name a vendor? Used by policy to bind a payment to the record that justifies it.
 *
 * A record names a vendor when it contains the vendor's full name, or a word from the name that is distinctive:
 * not a generic business word ("Transport", "Homestay", "Family", "Boats") and not part of any other known
 * vendor's name. "Driver: Phuong" names Phuong Transport; "transport by van" does not; "Maria" names Maria Santos
 * only while no other vendor is called Maria.
 */

const GENERIC = new Set(
  [
    "transport", "transports", "transportation", "family", "homestay", "homestays", "home", "house", "island", "islands", "boat", "boats",
    "rental", "rentals", "rent", "lodge", "lodges", "mountain", "mountains", "trekking", "trek", "treks", "collective", "tour", "tours",
    "travel", "travels", "guide", "guides", "guiding", "service", "services", "company", "group", "hotel", "hotels", "resort", "inn",
    "motorbike", "motorbikes", "bike", "bikes", "car", "cars", "van", "vans", "bus", "taxi", "driver", "drivers", "adventure",
    "adventures", "expedition", "expeditions", "trading", "the", "and", "ltd", "llc", "inc", "co", "jsc", "corp", "limited",
    "restaurant", "cafe", "kitchen", "food", "camp", "camping", "river", "valley", "lake", "beach", "village", "local", "travel",
    "studio", "media", "photo", "photography", "video", "events", "event", "staff", "team", "partners", "agency", "holidays",
  ],
);

export function normaliseName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const words = (s: string) => normaliseName(s).split(" ").filter((w) => w.length >= 3);

/** The words of a vendor's name that identify it on their own, given the other vendors the business has. */
export function distinctiveWords(name: string, otherNames: string[]): string[] {
  const others = new Set(otherNames.flatMap(words));
  return words(name).filter((w) => !GENERIC.has(w) && !others.has(w));
}

export function namesVendor(text: string, name: string, otherNames: string[]): boolean {
  const t = ` ${normaliseName(text)} `;
  const full = normaliseName(name);
  if (full && t.includes(` ${full} `)) return true;
  return distinctiveWords(name, otherNames).some((w) => t.includes(` ${w} `));
}
