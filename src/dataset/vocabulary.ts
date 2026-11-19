/**
 * Closed descriptor vocabulary: twelve themes and twelve mechanics.
 *
 * The hidden truth is written in these terms, and later enrichment may only
 * assert these terms. Regulated or per-market facts (RTP, volatility, stake
 * limits, bonus buy) are deliberately absent: they are carried raw and never
 * interpreted.
 */

export const THEMES = [
  "ancient_egypt",
  "mythology",
  "fantasy",
  "animals",
  "adventure",
  "classic_fruit",
  "east_asian",
  "irish_luck",
  "western",
  "horror",
  "ocean_fishing",
  "sci_fi",
] as const;

export const MECHANICS = [
  "paylines",
  "ways",
  "cluster_pays",
  "free_spins",
  "multipliers",
  "cascading_reels",
  "expanding_wilds",
  "sticky_wilds",
  "hold_and_respin",
  "pick_bonus",
  "progressive_jackpot",
  "mystery_symbols",
] as const;

/** How wins are evaluated. Every game has exactly one of these. */
export const WIN_SYSTEMS = ["paylines", "ways", "cluster_pays"] as const;

export type Theme = (typeof THEMES)[number];
export type Mechanic = (typeof MECHANICS)[number];
export type WinSystem = (typeof WIN_SYSTEMS)[number];
export type Term = Theme | Mechanic;

export const THEME_MEANING: Record<Theme, string> = {
  ancient_egypt: "pharaohs, pyramids, tombs and the gods of ancient Egypt",
  mythology: "gods and heroes of Greek, Norse or other classical myth",
  fantasy: "wizards, dragons, elves and invented magical worlds",
  animals: "wildlife or animal characters as the main subject",
  adventure: "explorers, expeditions and treasure hunts",
  classic_fruit: "traditional fruit-machine symbols: cherries, bells, bars and sevens",
  east_asian: "East Asian settings and symbols such as lanterns, dragon dances and temples",
  irish_luck: "Irish folklore: leprechauns, clovers, rainbows and pots of gold",
  western: "the American frontier: cowboys, saloons and outlaws",
  horror: "ghosts, vampires, haunted places and other dark, frightening subjects",
  ocean_fishing: "the sea, underwater life or fishing",
  sci_fi: "space travel, robots, aliens and future technology",
};

export const MECHANIC_MEANING: Record<Mechanic, string> = {
  paylines: "wins are paid on a fixed number of lines across the reels",
  ways: "wins are paid for matching symbols on adjacent reels in any position (ways to win)",
  cluster_pays: "wins are paid for groups of touching matching symbols rather than lines",
  free_spins: "a bonus round of spins that cost nothing",
  multipliers: "wins are multiplied by a factor that is applied or grows during play",
  cascading_reels: "winning symbols are removed and new symbols fall into the gaps",
  expanding_wilds: "wild symbols grow to cover a whole reel",
  sticky_wilds: "wild symbols stay locked in place for following spins",
  hold_and_respin: "special symbols lock in place while the remaining positions spin again",
  pick_bonus: "a bonus round in which the player picks hidden items to reveal prizes",
  progressive_jackpot: "a jackpot prize that grows with play until it is won",
  mystery_symbols: "symbols that land face-down and all reveal the same symbol",
};

export function isTheme(term: string): term is Theme {
  return (THEMES as readonly string[]).includes(term);
}
