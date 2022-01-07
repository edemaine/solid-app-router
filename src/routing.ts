import type { Component, JSX, Accessor } from "solid-js";
import {
  createComponent,
  createContext,
  createMemo,
  createRenderEffect,
  createSignal,
  on,
  untrack,
  useContext,
  useTransition
} from "solid-js";
import { isServer } from "solid-js/web";
import { normalizeIntegration } from "./integration";
import type {
  Branch,
  Location,
  LocationChange,
  LocationChangeSignal,
  NavigateOptions,
  Navigator,
  Params,
  Route,
  RouteContext,
  RouteDataFunc,
  RouteDefinition,
  RouteMatch,
  RouterContext,
  RouterIntegration,
  RouterOutput,
  SetParams
} from "./types";
import {
  createMemoObject,
  extractSearchParams,
  invariant,
  resolvePath,
  createMatcher,
  joinPaths,
  scoreRoute,
  mergeSearchString
} from "./utils";

const MAX_REDIRECTS = 100;

interface MaybePreloadableComponent extends Component {
  preload?: () => void;
}

export const RouterContextObj = createContext<RouterContext>();
export const RouteContextObj = createContext<RouteContext>();

export const useRouter = () =>
  invariant(useContext(RouterContextObj), "Make sure your app is wrapped in a <Router />");

export const useRoute = () => useContext(RouteContextObj) || useRouter().base;

export const useResolvedPath = (path: () => string) => {
  const route = useRoute();
  return createMemo(() => route.resolvePath(path()));
};

export const useHref = (to: () => string | undefined) => {
  const router = useRouter();
  return createMemo(() => {
    const to_ = to();
    return to_ !== undefined ? router.renderPath(to_) : to_;
  });
};

export const useNavigate = () => useRouter().navigatorFactory();
export const useLocation = <S = unknown>() => useRouter().location as Location<S>;
export const useIsRouting = () => useRouter().isRouting;

export const useMatch = (path: () => string) => {
  const location = useLocation();
  const matcher = createMemo(() => createMatcher(path()));
  return createMemo(() => matcher()(location.pathname));
};

export const useParams = <T extends Params>() => useRoute().params as T;

export const useSearchParams = <T extends Params>(): [
  T,
  (params: SetParams, options?: Partial<NavigateOptions>) => void
] => {
  const location = useLocation();
  const navigate = useNavigate();
  const setSearchParams = (params: SetParams, options?: Partial<NavigateOptions>) => {
    const searchString = mergeSearchString(location.search, params);
    navigate(searchString ? `?${searchString}` : "", { scroll: false, ...options, resolve: true });
  };
  return [location.query as T, setSearchParams];
};

export const useData = <T>(delta: number = 0) => {
  let current = useRoute();
  let n: number;
  if (delta >= 0) {
    // Nonnegative numbers count number of levels up from route
    n = delta;
  } else if (delta < 0) {
    // Negative numbers count backwards, down from root route
    let count = 1, ancestor = current;
    while (ancestor.parent) {
      ancestor = ancestor.parent;
      count++;
    }
    n = count + delta;
    if (n < 0) {
      throw new RangeError(`Route descendant ${delta} is out of bounds`);
    }
  }
  while (n!-- > 0) {
    if (!current.parent) {
      throw new RangeError(`Route ancestor ${delta} is out of bounds`);
    }
    current = current.parent;
  }
  return current.data as T;
};

export function createRoute(
  routeDef: RouteDefinition,
  base: string = "",
  fallback?: Component
): Route {
  const { path: originalPath, component, data, children } = routeDef;
  const isLeaf = !children || (Array.isArray(children) && !children.length);
  const path = joinPaths(base, originalPath);
  const pattern = isLeaf ? path : path.split("/*", 1)[0];

  return {
    originalPath,
    pattern,
    element: component
      ? () => createComponent(component, {})
      : () => {
          const { element } = routeDef;
          return element === undefined && fallback
            ? createComponent(fallback, {})
            : (element as JSX.Element);
        },
    preload: routeDef.component
      ? (component as MaybePreloadableComponent).preload
      : routeDef.preload,
    data,
    matcher: createMatcher(pattern, !isLeaf)
  };
}

export function createBranch(routes: Route[], index: number = 0): Branch {
  return {
    routes,
    score: scoreRoute(routes[routes.length - 1]) * 10000 - index,
    matcher(location) {
      const matches: RouteMatch[] = [];
      for (let i = routes.length - 1; i >= 0; i--) {
        const route = routes[i];
        const match = route.matcher(location);
        if (!match) {
          return null;
        }
        matches.unshift({
          ...match,
          route
        });
      }
      return matches;
    }
  };
}

export function createBranches(
  routeDef: RouteDefinition | RouteDefinition[],
  base: string = "",
  fallback?: Component,
  stack: Route[] = [],
  branches: Branch[] = []
): Branch[] {
  const routeDefs = Array.isArray(routeDef) ? routeDef : [routeDef];

  for (let i = 0, len = routeDefs.length; i < len; i++) {
    const def = routeDefs[i];
    const route = createRoute(def, base, fallback);

    stack.push(route);

    if (def.children) {
      createBranches(def.children, route.pattern, fallback, stack, branches);
    } else {
      const branch = createBranch([...stack], branches.length);
      branches.push(branch);
    }

    stack.pop();
  }

  // Stack will be empty on final return
  return stack.length ? branches : branches.sort((a, b) => b.score - a.score);
}

export function getRouteMatches(branches: Branch[], location: string): RouteMatch[] {
  for (let i = 0, len = branches.length; i < len; i++) {
    const match = branches[i].matcher(location);
    if (match) {
      return match;
    }
  }
  return [];
}

export function createLocation(path: Accessor<string>, state: Accessor<any>): Location {
  const origin = new URL("http://sar");
  const url = createMemo<URL>(
    prev => {
      const path_ = path();
      try {
        return new URL(path_, origin);
      } catch (err) {
        console.error(`Invalid path ${path_}`);
        return prev;
      }
    },
    origin,
    {
      equals: (a, b) => a.href === b.href
    }
  );

  const pathname = createMemo(() => url().pathname);
  const search = createMemo(() => url().search.slice(1));
  const hash = createMemo(() => url().hash.slice(1));
  const key = createMemo(() => "");

  return {
    get pathname() {
      return pathname();
    },
    get search() {
      return search();
    },
    get hash() {
      return hash();
    },
    get state() {
      return state();
    },
    get key() {
      return key();
    },
    query: createMemoObject(on(search, () => extractSearchParams(url())) as () => Params)
  };
}

export function createRouterContext(
  integration?: RouterIntegration | LocationChangeSignal,
  base: string = "",
  data?: RouteDataFunc,
  out?: object
): RouterContext {
  const {
    signal: [source, setSource],
    utils = {}
  } = normalizeIntegration(integration);

  const basePath = resolvePath("", base);
  const output =
    isServer && out
      ? (Object.assign(out, {
          matches: [],
          url: undefined
        }) as RouterOutput)
      : undefined;

  if (basePath === undefined) {
    throw new Error(`${basePath} is not a valid base path`);
  } else if (basePath && !source().value) {
    setSource({ value: basePath, replace: true, scroll: false });
  }

  const [isRouting, start] = useTransition();
  const [reference, setReference] = createSignal(source().value);
  const [state, setState] = createSignal(source().state);
  const location = createLocation(reference, state);
  const referrers: LocationChange[] = [];

  const baseRoute: RouteContext = {
    pattern: basePath,
    params: {},
    path: () => basePath,
    outlet: () => null,
    resolvePath(to: string) {
      return resolvePath(basePath, to);
    }
  };

  if (data) {
    baseRoute.data = data({ params: {}, location, navigate: navigatorFactory(baseRoute) });
  }

  function navigateFromRoute(
    route: RouteContext,
    to: string | number,
    options?: Partial<NavigateOptions>
  ) {
    // Untrack in case someone navigates in an effect - don't want to track `reference` or route paths
    untrack(() => {
      if (typeof to === "number") {
        if (!to) {
          // A delta of 0 means stay at the current location, so it is ignored
        } else if (utils.go) {
          utils.go(to);
        } else {
          console.warn("Router integration does not support relative routing");
        }
        return;
      }

      const {
        replace,
        resolve,
        scroll,
        state: nextState
      } = {
        replace: false,
        resolve: true,
        scroll: true,
        ...options
      };

      const resolvedTo = resolve ? route.resolvePath(to) : resolvePath("", to);

      if (resolvedTo === undefined) {
        throw new Error(`Path '${to}' is not a routable path`);
      } else if (referrers.length >= MAX_REDIRECTS) {
        throw new Error("Too many redirects");
      }

      const current = reference();

      if (resolvedTo !== current || nextState !== state()) {
        if (isServer) {
          if (output) {
            output.url = resolvedTo;
          }
          setSource({ value: resolvedTo, replace, scroll, state: nextState });
        } else {
          const len = referrers.push({ value: current, replace, scroll, state });
          start(() => {
            setReference(resolvedTo);
            setState(nextState);
          }).then(() => {
            if (referrers.length === len) {
              navigateEnd({
                value: resolvedTo,
                state: nextState
              });
            }
          });
        }
      }
    });
  }

  function navigatorFactory(route?: RouteContext): Navigator {
    // Workaround for vite issue (https://github.com/vitejs/vite/issues/3803)
    route = route || useContext(RouteContextObj) || baseRoute;
    return (to: string | number, options?: Partial<NavigateOptions>) =>
      navigateFromRoute(route!, to, options);
  }

  function navigateEnd(next: LocationChange) {
    const first = referrers[0];
    if (first) {
      if (next.value !== first.value || next.state !== first.state) {
        setSource({
          ...next,
          replace: first.replace,
          scroll: first.scroll
        });
      }
      referrers.length = 0;
    }
  }

  createRenderEffect(() => {
    const { value, state } = source();
    if (value !== untrack(reference)) {
      start(() => {
        setReference(value);
        setState(state);
      });
    }
  });

  return {
    base: baseRoute,
    out: output,
    location,
    isRouting,
    renderPath: utils.renderPath || ((path: string) => path),
    navigatorFactory
  };
}

export function createRouteContext(
  router: RouterContext,
  parent: RouteContext,
  child: () => RouteContext,
  match: () => RouteMatch
): RouteContext {
  const { base, location, navigatorFactory } = router;
  const { pattern, element: outlet, preload, data } = match().route;
  const path = createMemo(() => match().path);
  const params = createMemoObject(() => match().params);

  preload && preload();

  const route: RouteContext = {
    parent,
    pattern,
    get child() {
      return child();
    },
    path,
    params,
    outlet,
    resolvePath(to: string) {
      return resolvePath(base.path(), to, path());
    }
  };

  if (data) {
    route.data = data({ params, location, navigate: navigatorFactory(route) });
  }

  return route;
}
