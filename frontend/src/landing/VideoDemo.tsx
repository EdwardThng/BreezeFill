import { DEMO_VIDEO, DEMO_VIDEO_POSTER } from "./config";

export default function VideoDemo() {
  return (
    <section className="section video">
      <div className="video-head">
        <div>
          <p className="eyebrow">See it in action</p>
          <h2>The whole flow, start to finish.</h2>
        </div>
        <p>
          A consultation pasted, answers proposed with their sources, the two it
          refuses to guess between, and the fill — recorded from the extension.
        </p>
      </div>
      <div className="video-frame">
        {DEMO_VIDEO ? (
          <video
            controls
            preload="none"
            poster={DEMO_VIDEO_POSTER || undefined}
            src={DEMO_VIDEO}
          />
        ) : (
          <p className="video-placeholder">
            Demo video goes here — put the file in <code>frontend/public/</code>{" "}
            and set <code>DEMO_VIDEO</code> in <code>landing/config.ts</code>.
          </p>
        )}
      </div>
    </section>
  );
}
