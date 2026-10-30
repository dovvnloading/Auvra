/**
 * The editor's day preview: how many hours the sky's clock moves a second while the inspector plays the day
 * through, 0 when it does not. Play has its own clock, set by the sky's Day Length.
 */
export const dayPreview = {
    speed: 0,
    /** The clock of the frame that last moved it: with several views, once a frame. */
    time: -1,
};
