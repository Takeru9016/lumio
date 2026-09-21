/**
 * The V1 product limits of a learning path. They are product decisions, not
 * database constraints: the domain enforces them, so they live here once and no
 * check spells out a bare 20, 100 or 1000.
 */
export const LEARNING_PATH_MAX_COURSES = 20;
export const LEARNING_PATH_TITLE_MAX_LENGTH = 100;
export const LEARNING_PATH_DESCRIPTION_MAX_LENGTH = 1000;

/** How many paths one page of the admin list holds by default, and the most it may hold. */
export const LEARNING_PATH_PAGE_SIZE = 50;
export const LEARNING_PATH_PAGE_MAX = 200;
