/**
 * The front door.
 *
 * The site's only job now is to hand out the extension and show what it does.
 * Everything here is static: no API call, no backend dependency, so the page
 * still renders if the server is asleep — which it now is, most of the time.
 *
 * Tone note, because it is easy to undo by accident: this product's claim is
 * *precision*, not coverage. Copy that promises to fill whole forms
 * automatically would be writing a cheque the software deliberately refuses to
 * cash — it leaves fields blank rather than guess, and it never submits. Say
 * that plainly; for a doctor signing the result, it is the selling point.
 *
 * Each section lives in `landing/`, one file per section, with its copy beside
 * it. The URLs, price and asset paths live in `landing/config.ts` and are
 * re-exported here, so `Subscribe.tsx` and the tests import them from this
 * file as before.
 */

import Closing from "./landing/Closing";
import Faq from "./landing/Faq";
import Hero from "./landing/Hero";
import HowItWorks from "./landing/HowItWorks";
import Marquee from "./landing/Marquee";
import Nav from "./landing/Nav";
import Pricing from "./landing/Pricing";
import Privacy from "./landing/Privacy";
import Problem from "./landing/Problem";
import ScrollDemo from "./landing/ScrollDemo";
import VideoDemo from "./landing/VideoDemo";

export {
  DEMO_VIDEO,
  DEMO_VIDEO_POSTER,
  DOWNLOAD_URL,
  GET_ROUTE,
  HERO_SHOT,
  PRICE,
  STORE_ID,
  STORE_URL,
  subscribeUrl,
} from "./landing/config";

export default function Landing() {
  return (
    <div className="landing">
      <Nav />
      <Hero />
      <Marquee />
      <Problem />
      <ScrollDemo />
      <HowItWorks />
      <Privacy />
      <VideoDemo />
      <Pricing />
      <Faq />
      <Closing />
    </div>
  );
}
