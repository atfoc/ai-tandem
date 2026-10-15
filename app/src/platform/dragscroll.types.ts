// What a touch drag needs of the page (AD-70): a finger that has been held on a row and then moves must drag the row, not scroll the list.
export type ScrollGuard = {
  /** Tells the guard which element the list is drawn in (the box around the sidebar's scroll view); null lets go of it. */
  guard: (el: unknown) => void;
  /** While `on`, a touch that moves on the guarded list does not scroll it. */
  hold: (on: boolean) => void;
};
