import { useEffect, useState } from "react";
import ClaimApp from "./ClaimApp";
import Demo from "./Demo";
import Landing from "./Landing";
import Subscribe from "./Subscribe";

/**
 * Routing, by hash and by hand.
 *
 * Three screens do not justify a router dependency, and the hash has one
 * property worth having here: the backend serves this bundle from a catch-all
 * StaticFiles mount, so a real path like /demo would be handled by the server
 * before React ever saw it. Everything after the # never leaves the browser.
 */
export type Route = "landing" | "demo" | "app" | "get";

export function routeOf(hash: string): Route {
  const path = String(hash || "").replace(/^#\/?/, "").split(/[?/]/)[0];
  if (path === "demo") return "demo";
  if (path === "app") return "app";
  // Stripe returns to #/get?paid=1, so the query has to survive the split
  // above — it does, because the path is taken before the "?" — and be read
  // from the hash by the page itself.
  if (path === "get") return "get";
  return "landing";
}

/**
 * A hash like #pricing names a place on the landing page, not a screen.
 *
 * The browser scrolls to it on its own; the hashchange handler must leave that
 * alone rather than reset to the top as it does for a change of screen.
 */
export function sectionOf(hash: string): string | null {
  const match = /^#([^/?].*)$/.exec(String(hash || ""));
  return match && routeOf(hash) === "landing" ? match[1] : null;
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash;
      setRoute(routeOf(hash));
      if (!sectionOf(hash)) window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (route === "app") return <ClaimApp />;
  if (route === "demo") return <Demo />;
  if (route === "get") return <Subscribe />;
  return <Landing />;
}
