/** UI texts of the strategy config (`strategy/config.py`), Polish and English. */

/** Default name of the periodic review by `review.every` (`REVIEW_EVERY` / `REVIEW_EVERY_EN`). */
export const reviewNames = {
  week: { pl: "Przegląd tygodnia", en: "Weekly review" },
  "2weeks": { pl: "Przegląd dwutygodniowy", en: "Biweekly review" },
  month: { pl: "Przegląd miesiąca", en: "Monthly review" },
} as const;
