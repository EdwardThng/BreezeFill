import { DEMO_VIDEO, DEMO_VIDEO_POSTER } from "./config";

/**
 * The recorded walkthrough. Absent until there is a recording.
 *
 * This used to render a placeholder telling the owner where to put the file,
 * which meant every visitor to the live site read a developer's note. With no
 * DEMO_VIDEO set the section is simply not on the page; set it in
 * landing/config.ts (a path under frontend/public/) and it appears.
 */
export default function VideoDemo() {
  if (!DEMO_VIDEO) return null;
  return (
    <section className="section video">
      <div className="video-head">
        <h2>The whole flow, start to finish.</h2>
        <p>
          A consultation pasted, answers proposed with their sources, the two it
          refuses to guess between, and the fill — recorded from the extension.
        </p>
      </div>
      <div className="video-frame">
        <video
          controls
          preload="none"
          poster={DEMO_VIDEO_POSTER || undefined}
          src={DEMO_VIDEO}
        />
      </div>
    </section>
  );
}
