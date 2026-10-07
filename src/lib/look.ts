export type HairStyle = "bald" | "lowcut" | "afro" | "puffs" | "braids" | "cornrows" | "locs" | "twists" | "bun" | "gele" | "turban" | "hijab";
export type TopStyle =
  | "tee"
  | "hoodie"
  | "dress"
  | "suit"
  | "jersey"
  | "worker"
  | "overalls"
  | "singlet"
  | "senator"
  | "buba"
  | "babariga"
  | "isiagu"
  | "ankara"
  | "gown"
  | "asooke"
  | "agbada";
export type Accessory = "none" | "glasses" | "sunglasses" | "cap" | "fila" | "hula" | "igbocap";
export type Build = "slim" | "regular" | "broad";
export type Frame = "m" | "f";

export type Look = {
  skin: string;
  /** body type; optional so older saved looks still load */
  frame?: Frame;
  build: Build;
  hairStyle: HairStyle;
  hairColor: string;
  top: TopStyle;
  topColor: string;
  bottomColor: string;
  shoeColor: string;
  accessory: Accessory;
};

export const SKIN_TONES = ["#b07a52", "#9a6642", "#85553a", "#704630", "#5c3a28", "#472c1f", "#33201a"];
export const HAIR_COLORS = ["#15110e", "#3b2a1d", "#6b4a2f", "#b8862b", "#c0392b", "#7b5cd6", "#e8e8e4"];
export const CLOTH_COLORS = [
  "#f4f4f2",
  "#1d2433",
  "#0f766e",
  "#16a34a",
  "#f59e0b",
  "#ec4899",
  "#6366f1",
  "#dc2626",
  "#0ea5e9",
  "#7c3aed",
];

export const HAIR_STYLES: { id: HairStyle; label: string }[] = [
  { id: "lowcut", label: "Natural" },
  { id: "bald", label: "Bald" },
  { id: "afro", label: "Afro" },
  { id: "puffs", label: "Afro puffs" },
  { id: "braids", label: "Braids" },
  { id: "cornrows", label: "Cornrows" },
  { id: "locs", label: "Locs" },
  { id: "twists", label: "Twists" },
  { id: "bun", label: "Bun" },
  { id: "gele", label: "Gele" },
];

export const TOP_STYLES: { id: TopStyle; label: string; frames: Frame[]; group: "Everyday" | "Nigerian" }[] = [
  { id: "tee", label: "T-shirt", frames: ["m", "f"], group: "Everyday" },
  { id: "hoodie", label: "Hoodie", frames: ["m"], group: "Everyday" },
  { id: "dress", label: "Dress", frames: ["f"], group: "Everyday" },
  { id: "suit", label: "Office suit", frames: ["m", "f"], group: "Everyday" },
  { id: "jersey", label: "Super Eagles jersey", frames: ["m", "f"], group: "Everyday" },
  { id: "worker", label: "Hi-vis worker", frames: ["m", "f"], group: "Everyday" },
  { id: "overalls", label: "Overalls", frames: ["m"], group: "Everyday" },
  { id: "singlet", label: "Singlet & shorts", frames: ["m"], group: "Everyday" },
  { id: "senator", label: "Senator kaftan", frames: ["m"], group: "Nigerian" },
  { id: "buba", label: "Buba & sokoto", frames: ["m"], group: "Nigerian" },
  { id: "isiagu", label: "Isi agu", frames: ["m", "f"], group: "Nigerian" },
  { id: "agbada", label: "Agbada", frames: ["m", "f"], group: "Nigerian" },
  { id: "ankara", label: "Ankara iro & buba", frames: ["f"], group: "Nigerian" },
  { id: "asooke", label: "Aso-oke & ipele", frames: ["f"], group: "Nigerian" },
  { id: "gown", label: "Ankara gown", frames: ["f"], group: "Nigerian" },
];

/** Outfits that exist for a body type. */
export const topsFor = (frame: Frame | undefined) => TOP_STYLES.filter((t) => t.frames.includes(frame ?? "m"));

export const ACCESSORIES: { id: Accessory; label: string }[] = [
  { id: "none", label: "None" },
  { id: "glasses", label: "Glasses" },
  { id: "sunglasses", label: "Sunglasses" },
  { id: "cap", label: "Cap" },
  { id: "fila", label: "Fila" },
  { id: "igbocap", label: "Igbo red cap" },
];

export const BUILDS: { id: Build; label: string }[] = [
  { id: "slim", label: "Slim" },
  { id: "regular", label: "Regular" },
  { id: "broad", label: "Broad" },
];

export const FRAMES: { id: Frame; label: string }[] = [
  { id: "m", label: "Masculine" },
  { id: "f", label: "Feminine" },
];

export const DEFAULT_LOOK: Look = {
  skin: "#7a4a2c",
  frame: "m",
  build: "regular",
  hairStyle: "lowcut",
  hairColor: "#15110e",
  top: "tee",
  topColor: "#0f766e",
  bottomColor: "#1d2433",
  shoeColor: "#f4f4f2",
  accessory: "none",
};

type Rng = () => number;

function makeLook(r: Rng): Look {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const frame = pick(FRAMES).id;
  const hairStyle = pick(HAIR_STYLES).id;
  const headwear = hairStyle === "gele" || hairStyle === "turban" || hairStyle === "hijab" || hairStyle === "afro" || hairStyle === "puffs";
  return {
    skin: pick(SKIN_TONES.slice(1)),
    frame,
    build: pick(BUILDS).id,
    hairStyle,
    hairColor: pick(HAIR_COLORS.slice(0, 4)),
    top: pick(topsFor(frame)).id,
    topColor: pick(CLOTH_COLORS),
    bottomColor: pick(["#1d2433", "#3a3f4b", "#0f766e", "#7c5a3a", "#f4f4f2"]),
    shoeColor: pick(["#f4f4f2", "#1d2433", "#dc2626", "#f59e0b"]),
    accessory: headwear ? pick<Accessory>(["none", "none", "glasses", "sunglasses"]) : pick(ACCESSORIES).id,
  };
}

export const randomLook = (): Look => makeLook(Math.random);

/** The same look every time for the same seed (used for shopkeepers, residents and so on). */
export function seededLook(seed: string): Look {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const r: Rng = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  return makeLook(r);
}

/** A market woman or aunty: always a woman, in wrapper and blouse or gown, usually with a gele. */
export function womanLook(seed: string): Look {
  const base = seededLook(seed);
  let h = 7;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const tops = ["ankara", "asooke", "gown", "ankara"] as const;
  const hair = ["gele", "gele", "twists", "cornrows", "gele"] as const;
  return { ...base, frame: "f", top: tops[h % tops.length], hairStyle: hair[(h >> 3) % hair.length], accessory: "none" };
}

/** Stable pastel-ish colour for a player id (used for land ownership tint). */
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 50%)`;
}
