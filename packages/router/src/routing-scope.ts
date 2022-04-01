/* eslint-disable max-lines-per-function */
/* eslint-disable max-lines-per-function */
import { NavigationCoordinator } from './navigation-coordinator';
import { IViewportScopeOptions, ViewportScope } from './endpoints/viewport-scope.js';
import { CustomElement, ICustomElementController, ICustomElementViewModel } from '@aurelia/runtime-html';
import { FoundRoute } from './found-route.js';
import { IRouter } from './router.js';
import { RoutingInstruction } from './instructions/routing-instruction.js';
import { Viewport } from './endpoints/viewport.js';
import { IViewportOptions } from './endpoints/viewport-options.js';
import { IConfigurableRoute, RouteRecognizer } from './route-recognizer.js';
import { Runner, Step } from './utilities/runner.js';
import { IRoute, Route } from './route.js';
import { Endpoint, IConnectedCustomElement, IEndpoint } from './endpoints/endpoint.js';
import { EndpointMatcher, IMatchEndpointsResult } from './endpoint-matcher.js';
import { EndpointContent, Navigation, Router, RoutingHook, ViewportCustomElement } from './index.js';
import { IContainer } from '@aurelia/kernel';
import { arrayRemove, arrayUnique } from './utilities/utils.js';

export type TransitionAction = 'skip' | 'reload' | 'swap' | '';

/**
 * The router uses routing scopes to organize all endpoints (viewports and viewport
 * scopes) into two hierarchical structures. Each routing scope belongs to a parent/child
 * hierarchy, that follows the DOM and is used when routing scopes are added and removed,
 * and an owner/owning hierarchy that's used when finding endpoints. Every routing scope
 * has a routing scope that owns it (except the root) and can in turn have several
 * routing scopes that it owns. A routing scope always has a connected endpoint content
 * and an endpoint content always has a connected routing scope.
 *
 * Every navigtion/load instruction that the router processes is first tied to a
 * routing scope, either a specified scope or the root scope. That routing scope is
 * then asked to
 * 1a) find routes (and their routing instructions) in the load instruction based on
 * the endpoint and its content (configured routes), and/or
 * 1b) find (direct) routing instructions in the load instruction.
 *
 * After that, the routing scope is used to
 * 2) match each of its routing instructions to an endpoint (viewport or viewport scope), and
 * 3) set the scope of the instruction to the next routing scopes ("children") and pass
 * the instructions on for matching in their new routing scopes.
 *
 * Once (component) transitions start in endpoints, the routing scopes assist by
 * 4) propagating routing hooks vertically through the hierarchy and disabling and
 * enabling endpoint contents and their routing data (routes) during transitions.
 *
 * Finally, when a navigation is complete, the routing scopes helps
 * 5) structure all existing routing instructions into a description of the complete
 * state of all the current endpoints and their contents.
 *
 * The hierarchy of the owner/owning routing scopes often follows the parent/child DOM
 * hierarchy, but it's not a necessity; it's possible to have routing scopes that doesn't
 * create their own "owning capable scope", and thus placing all their "children" under the
 * same "parent" as themselves or for a routing scope to hoist itself up or down in the
 * hierarchy and, for example, place itself as a "child" to a DOM sibling endpoint.
 * (Scope self-hoisting will not be available for early-on alpha.)
 */

export class RoutingScope {
  public static lastId = 0;

  public id = -1;

  /**
   * The parent of the routing scope (parent/child hierarchy)
   */
  public parent: RoutingScope | null = null;
  /**
   * The children of the routing scope (parent/child hierarchy)
   */
  public children: RoutingScope[] = [];

  public path: string | null = null;

  public constructor(
    public readonly router: IRouter,
    /**
     * Whether the routing scope has a scope and can own other scopes
     */
    public readonly hasScope: boolean,

    /**
     * The routing scope that owns this routing scope (owner/owning hierarchy)
     */
    public owningScope: RoutingScope | null,

    /**
     * The endpoint content the routing scope is connected to
     */
    public endpointContent: EndpointContent,
  ) {
    this.id = ++RoutingScope.lastId;
    this.owningScope = owningScope ?? this;
    // console.log('Created RoutingScope', this.id, this);
  }

  public static for(origin: Element | ICustomElementViewModel | Viewport | ViewportScope | RoutingScope | ICustomElementController | IContainer | null): RoutingScope | null {
    if (origin == null) {
      return null;
    }
    if (origin instanceof RoutingScope || origin instanceof Viewport || origin instanceof ViewportScope) {
      return origin.scope;
    }
    // return this.getClosestScope(origin) || this.rootScope!.scope;
    let container: IContainer | null | undefined;

    // res is a private prop of IContainer impl
    // TODO: should use a different way to detect if something is a container
    // or move this to the bottom if this else-if
    if ('res' in origin) {
      container = origin;
    } else {
      if ('container' in origin) {
        container = origin.container;
      } else if ('$controller' in origin) {
        container = origin.$controller!.container;
      } else {
        const controller = CustomElement.for(origin as Node, { searchParents: true });
        container = controller?.container;
      }
    }
    if (container == null) {
      return null;
    }
    const closestEndpoint = (container.has(Router.closestEndpointKey, true)
      ? container.get(Router.closestEndpointKey)
      : null) as Endpoint | null;
    return closestEndpoint?.scope ?? null;
  }

  /**
   * The routing scope children to this scope are added to. If this routing
   * scope has scope, this scope property equals this scope itself. If it
   * doesn't have scope this property equals the owning scope. Using this
   * ensures that routing scopes that don't have a their own scope aren't
   * part of the owner/owning hierarchy.
   */
  public get scope(): RoutingScope {
    return this.hasScope ? this : this.owningScope!.scope;
  }
  public get endpoint(): Endpoint {
    return this.endpointContent.endpoint;
  }
  public get isViewport(): boolean {
    return this.endpoint instanceof Viewport;
  }
  public get isViewportScope(): boolean {
    return this.endpoint instanceof ViewportScope;
  }

  public get type(): string {
    return this.isViewport ? 'Viewport' : 'ViewportScope';
  }

  public get enabled(): boolean {
    return this.endpointContent.isActive;
  }

  public get passThroughScope(): boolean {
    return this.isViewportScope && (this.endpoint as ViewportScope).passThroughScope;
  }

  public get pathname(): string {
    return `${this.owningScope !== this ? this.owningScope!.pathname : ''}/${this.endpoint!.name}`;
  }

  public toString(recurse = false): string {
    return `${this.owningScope !== this ? this.owningScope!.toString() : ''}/${!this.enabled ? '(' : ''}${this.endpoint!.toString()}#${this.id}${!this.enabled ? ')' : ''}` +
      // eslint-disable-next-line prefer-template
      `${recurse ? `\n` + this.children.map(child => child.toString(true)).join('') : ''}`;
  }

  public toStringOwning(recurse = false): string {
    return `${this.owningScope !== this ? this.owningScope!.toString() : ''}/${!this.enabled ? '(' : ''}${this.endpoint!.toString()}#${this.id}${!this.enabled ? ')' : ''}` +
      // eslint-disable-next-line prefer-template
      `${recurse ? `\n` + this.ownedScopes.map(child => child.toStringOwning(true)).join('') : ''}`;
  }

  public get enabledChildren(): RoutingScope[] {
    return this.children.filter(scope => scope.enabled);
  }
  public get hoistedChildren(): RoutingScope[] {
    const scopes = this.enabledChildren;
    while (scopes.some(scope => scope.passThroughScope)) {
      for (const scope of scopes.slice()) {
        if (scope.passThroughScope) {
          const index = scopes.indexOf(scope);
          scopes.splice(index, 1, ...scope.enabledChildren);
        }
      }
    }
    return scopes;
  }
  public get ownedScopes(): RoutingScope[] {
    return this.getOwnedScopes();
  }

  public get routingInstruction(): RoutingInstruction | null {
    if (this.endpoint.isViewportScope) {
      return (this.endpoint as ViewportScope).instruction;
    }
    if (this.isViewport) {
      return (this.endpoint as Viewport).activeContent.instruction;
    }
    return null;
  }

  public getRoutingInstruction(index?: number): RoutingInstruction | null {
    if (this.endpoint.isViewportScope) {
      return (this.endpoint as ViewportScope).instruction;
    }
    if (this.isViewport) {
      return index !== void 0
        ? ((this.endpoint as Viewport).getTimeContent(index)?.instruction ?? null)
        : (this.endpoint as Viewport).getContent().instruction;
    }
    return null;
  }

  public getOwnedScopes(includeDisabled: boolean = false): RoutingScope[] {
    const scopes = this.allScopes(includeDisabled).filter(scope => scope.owningScope === this);
    // Hoist children to pass through scopes
    for (const scope of scopes.slice()) {
      if (scope.passThroughScope) {
        const index = scopes.indexOf(scope);
        scopes.splice(index, 1, ...scope.getOwnedScopes());
      }
    }
    return scopes;
  }

  public async processInstructions(instructions: RoutingInstruction[], navigation: Navigation, coordinator: NavigationCoordinator, configuredRoutePath = ''): Promise<Endpoint[]> {
    const router = this.router;
    const options = router.configuration.options;

    // If there are instructions that aren't part of an already found configured route...
    const nonRouteInstructions = instructions.filter(instruction => instruction.route == null);
    if (nonRouteInstructions.length > 0) {
      // ...find the routing instructions for them. The result will be either that there's a configured
      // route (which in turn contains routing instructions) or a list of routing instructions
      // TODO(return): This needs to be updated
      const foundRoute = this.findInstructions(nonRouteInstructions, options.useDirectRouting, options.useConfiguredRoutes);

      // Make sure we got routing instructions...
      if (nonRouteInstructions.some(instr => !instr.component.none) && !foundRoute.foundConfiguration && !foundRoute.foundInstructions) {
        // ...call unknownRoute hook if we didn't...
        // TODO: Add unknownRoute hook here and put possible result in instructions
        router.unknownRoute(RoutingInstruction.stringify(router, nonRouteInstructions));
      }
      // ...and use any already found and the newly found routing instructions.
      instructions = [...instructions.filter(instruction => instruction.route != null), ...foundRoute.instructions];

      if (instructions.some(instr => instr.scope !== this)) {
        console.warn('Not the current scope for instruction(s)!', this, instructions);
      }

      // If it's a configured route...
      if (foundRoute.foundConfiguration) {
        // // ...trim leading slash and ...
        // navigation.path = (navigation.instruction as string).replace(/^\//, '');
        // ...store the matching route.
        configuredRoutePath = (configuredRoutePath ?? '') + foundRoute.matching;
        // if (this === router.rootScope!.scope) {
        //   router.rootScope!.path = configuredRoutePath;
        // }
      }
    }
    // TODO: Used to have an early exit if no instructions. Restore it?

    // If there are any unresolved components (functions or promises), resolve into components
    const unresolved = instructions.filter(instr => instr.component.isFunction() || instr.component.isPromise());
    if (unresolved.length > 0) {
      // TODO(alpha): Fix type here
      await Promise.all(unresolved.map(instr => instr.component.resolve() as Promise<any>));
    }

    // If router options defaults to navigations being full state navigation (containing the
    // complete set of routing instructions rather than just the ones that change), ensure
    // that there's an instruction to clear all non-specified viewports in the same scope as
    // the first routing instruction.
    // TODO: There should be a clear all instruction in all the scopes of the top instructions
    if (!options.additiveInstructionDefault) {
      instructions = this.ensureClearStateInstruction(instructions);
    }

    // Get all endpoints affected by any clear all routing instructions and then remove those
    // routing instructions.
    let clearEndpoints: Endpoint[] = [];
    ({ clearEndpoints, instructions } = this.getClearAllEndpoints(instructions));

    // Make sure "add all" instructions have the correct name and scope
    for (const addInstruction of instructions.filter(instr => instr.isAddAll(router))) {
      addInstruction.endpoint.set(addInstruction.scope!.endpoint.name);
      addInstruction.scope = addInstruction.scope!.owningScope!;
    }

    // Mark all as top instructions ("children"/next scope instructions are in a property on
    // routing instruction) that will get assured parallel lifecycle swaps
    // TODO(alpha): Look into refactoring so this isn't used
    // TODO(return): Needs to be moved outside of scope!
    // for (const instr of instructions) {
    //   instr.topInstruction = true;
    // }

    const allChangedEndpoints: IEndpoint[] = [];
    let earlierMatchedInstructions: RoutingInstruction[] = [];

    // Match the instructions to available endpoints within, and with the help of, their scope
    // TODO(return): This needs to be updated
    let { matchedInstructions, remainingInstructions } = this.matchEndpoints(instructions, earlierMatchedInstructions);
    let guard = 100;
    do {
      if (!guard--) { // Guard against endless loop
        router.unresolvedInstructionsError(navigation, remainingInstructions);
      }
      const changedEndpoints: IEndpoint[] = [];

      // Get all the endpoints of matched instructions...
      const matchedEndpoints = matchedInstructions.map(instr => instr.endpoint.instance);
      // ...and create and add clear instructions for all endpoints that
      // aren't already in an instruction.
      matchedInstructions.push(...clearEndpoints
        .filter(endpoint => !matchedEndpoints.includes(endpoint))
        .map(endpoint => RoutingInstruction.createClear(router, endpoint)));

      // TODO: Review whether this await poses a problem (it's currently necessary for new viewports to load)
      const hooked = await RoutingHook.invokeBeforeNavigation(matchedInstructions, navigation);
      if (hooked === false) {
        router.cancelNavigation(navigation, coordinator);
        return [];
      } else if (hooked !== true && hooked !== matchedInstructions) {
        // TODO(return): Do a full findInstructions again with a new FoundRoute so that this
        // hook can return other values as well
        const skipped = RoutingInstruction.flat(matchedInstructions);
        remainingInstructions = remainingInstructions.filter(instr => !skipped.includes(instr));
        matchedInstructions = hooked;
        // foundRoute.remaining = '';
      }

      for (const matchedInstruction of matchedInstructions) {
        const endpoint = matchedInstruction.endpoint.instance;
        if (endpoint !== null) {
          // Set endpoint path to the configured route path so that it knows it's part
          // of a configured route.
          // endpoint.path = configuredRoutePath;
          // Inform endpoint of new content and retrieve the action it'll take
          const action = endpoint.setNextContent(matchedInstruction, navigation);
          if (action !== 'skip') {
            // Add endpoint to changed endpoints this iteration and to the coordinator's purview
            changedEndpoints.push(endpoint);
            coordinator.addEndpoint(endpoint);
          }
          // We're doing something, so don't clear this endpoint...
          const dontClear = [endpoint];
          if (action === 'swap') {
            // ...and none of it's _current_ children if we're swapping them out.
            dontClear.push(...endpoint.getContent().connectedScope.allScopes(true).map(scope => scope.endpoint));
          }
          // Exclude the endpoints to not clear from the ones to be cleared...
          arrayRemove(clearEndpoints, clear => dontClear.includes(clear));
          // ...as well as already matched clear instructions (but not itself).
          arrayRemove(matchedInstructions, matched => matched !== matchedInstruction
            && matched.isClear(router) && dontClear.includes(matched.endpoint.instance!));
          // And also exclude the routing instruction's parent viewport scope...
          if (!matchedInstruction.isClear(router) && matchedInstruction.scope?.parent?.isViewportScope) {
            // ...from clears...
            arrayRemove(clearEndpoints, clear => clear === matchedInstruction.scope!.parent!.endpoint);
            // ...and already matched clears.
            arrayRemove(matchedInstructions, matched => matched !== matchedInstruction
              && matched.isClear(router) && matched.endpoint.instance === matchedInstruction.scope!.parent!.endpoint);
          }
          // If the endpoint has been changed/swapped the next scope instructions
          // need to be moved into the new endpoint content scope and the endpoint
          // instance needs to be cleared
          if (action !== 'skip' && matchedInstruction.hasNextScopeInstructions) {
            for (const nextScopeInstruction of matchedInstruction.nextScopeInstructions!) {
              nextScopeInstruction.scope = endpoint.scope;
              nextScopeInstruction.endpoint.instance = null;
            }
          }
          // If the endpoint has not been changed/swapped and there are no next scope
          // instructions the endpoint's scope (its children) needs to be cleared
          if (action === 'skip' && !matchedInstruction.hasNextScopeInstructions) {
            allChangedEndpoints.push(...(await endpoint.scope.processInstructions([], navigation, coordinator, configuredRoutePath)));
          }
        }
      }

      // In order to make sure all relevant canUnload are run on the first run iteration
      // we only run once all (top) instructions are doing something/there are no skip
      // action instructions.
      // If all first iteration instructions now do something the transitions can start
      const skipping = matchedInstructions.filter(instr => instr.endpoint.instance?.transitionAction === 'skip');
      const skippingWithMore = skipping.filter(instr => instr.hasNextScopeInstructions);
      if (skipping.length === 0 || (skippingWithMore.length === 0)) { // TODO: !!!!!!  && !foundRoute.hasRemaining)) {
        // If navigation is unrestricted (no other syncing done than on canUnload) we can tell
        // the navigation coordinator to instruct endpoints to transition
        if (!router.isRestrictedNavigation) {
          coordinator.finalEndpoint();
        }
        coordinator.run();

        // Wait for ("blocking") canUnload to finish
        if (coordinator.hasAllEndpoints) {
          const guardedUnload = coordinator.waitForSyncState('guardedUnload');
          if (guardedUnload instanceof Promise) {
            // console.log('>>> Waiting for guardedUnload', (coordinator as any).entities.map((ent: any) => ent.entity.toString()).join(','));
            await guardedUnload;
            // console.log('<<< Waited for guardedUnload');
          }
        }
      }

      // If, for whatever reason, this navigation got cancelled, stop processing
      if (coordinator.cancelled) {
        router.cancelNavigation(navigation, coordinator);
        return [];
      }

      // Add this iteration's changed endpoints (inside the loop) to the total of all
      // updated endpoints (outside the loop)
      for (const changedEndpoint of changedEndpoints) {
        if (allChangedEndpoints.every(endpoint => endpoint !== changedEndpoint)) {
          allChangedEndpoints.push(changedEndpoint);
        }
      }

      // Make sure these endpoints in these instructions stays unavailable
      earlierMatchedInstructions.push(...matchedInstructions.splice(0));

      // TODO: Fix multi level recursiveness?
      // Endpoints have now (possibly) been added or removed, so try and match
      // any remaining instructions
      if (remainingInstructions.length > 0) {
        ({ matchedInstructions, remainingInstructions } = this.matchEndpoints(remainingInstructions, earlierMatchedInstructions));
      }

      // If this isn't a restricted ("static") navigation everything will run as soon as possible
      // and then we need to wait for new viewports to be loaded before continuing here (but of
      // course only if we're running)
      // TODO: Use a better solution here (by checking and waiting for relevant viewports)
      if (!router.isRestrictedNavigation &&
        (matchedInstructions.length > 0 || remainingInstructions.length > 0) &&
        coordinator.running) {
        // const waitForSwapped = coordinator.waitForSyncState('bound');
        // if (waitForSwapped instanceof Promise) {
        // //   console.log('>>> AWAIT waitForBound');
        //   await waitForSwapped;
        // //   console.log('<<< AWAIT waitForBound');
        // }
        const waitForSwapped = coordinator.waitForSyncState('swapped');
        if (waitForSwapped instanceof Promise) {
          // console.log('>>> AWAIT waitForSwapped');
          await waitForSwapped;
          // console.log('<<< AWAIT waitForSwapped');
        }
      }

      // Look for child routes (configured) and instructions (once we've loaded everything so far?)
      if (matchedInstructions.length === 0 && remainingInstructions.length === 0) {
        // // If this isn't a restricted ("static") navigation everything will run as soon as possible
        // // and then we need to wait for new viewports to be loaded before continuing here
        // // TODO: Use a better solution here (by checking and waiting for relevant viewports)
        // if (!this.isRestrictedNavigation) {
        //   // const waitForSwapped = coordinator.waitForSyncState('bound');
        //   // if (waitForSwapped instanceof Promise) {
        //   //   console.log('AWAIT waitForBound');
        //   //   await waitForSwapped;
        //   // }
        //   const waitForSwapped = coordinator.waitForSyncState('swapped');
        //   if (waitForSwapped instanceof Promise) {
        //     console.log('AWAIT waitForSwapped');
        //     await waitForSwapped;
        //   }
        // }

        // Get child route (configured) and instructions (if any)
        const nextProcesses = [];
        for (const instruction of instructions) {
          if (!instruction.hasNextScopeInstructions) {
            continue;
          }
          const nextScope = instruction.endpoint.instance?.scope ?? instruction.endpoint.scope as RoutingScope;
          nextProcesses.push(nextScope.processInstructions(instruction.nextScopeInstructions!, navigation, coordinator, configuredRoutePath));
        }
        allChangedEndpoints.push(...(await Promise.all(nextProcesses)).flat());

        // const { foundChildRoute, configuredChildRoutePath } = this.findChildRoute(earlierMatchedInstructions, foundRoute, configuredRoutePath);

        // // Proceed with found child route...
        // if (foundChildRoute.foundInstructions) {
        //   // ...by making it the current route...
        //   foundRoute = foundChildRoute;
        //   // ...and the current configured route path...
        //   configuredRoutePath = configuredChildRoutePath;
        //   // ...and add the instructions to processing...
        //   router.appendInstructions(foundChildRoute.instructions);
        // } else { // ...or deal with unknown route
        //   // TODO: Add unknownRoute hook here and put possible result in instructions
        //   this.unknownRoute(foundChildRoute.remaining);
        // }
      }

      // Don't add defaults when it's a full state navigation (since it's complete state)
      if (navigation.useFullStateInstruction) {
        coordinator.appendedInstructions = coordinator.appendedInstructions.filter(instr => !instr.default);
      }

      // If there are any unresolved components (promises) to be appended, resolve them
      const unresolved = coordinator.appendedInstructions.filter(instr => instr.component.isPromise());
      if (unresolved.length > 0) {
        // TODO(alpha): Fix type here
        await Promise.all(unresolved.map(instr => instr.component.resolve() as Promise<any>));
      }

      // Dequeue any instructions appended to the coordinator and add to either matched or
      // remaining. Default instructions aren't added if there's already a non-default
      ({ matchedInstructions, earlierMatchedInstructions, remainingInstructions } =
        coordinator.dequeueAppendedInstructions(matchedInstructions, earlierMatchedInstructions, remainingInstructions));

      // Once done with all explicit instructions...
      if (matchedInstructions.length === 0 && remainingInstructions.length === 0) {
        // ...check if we've got pending children (defaults that hasn't connected yet)...
        const pendingEndpoints = earlierMatchedInstructions
          .map(instr => (instr.endpoint.instance?.connectedCE as ViewportCustomElement).pendingPromise?.promise)
          .filter(promise => promise != null);
        // ...and await first one...
        if (pendingEndpoints.length > 0) {
          await Promise.any(pendingEndpoints);
          // ...and dequeue them.
          ({ matchedInstructions, earlierMatchedInstructions, remainingInstructions } =
            coordinator.dequeueAppendedInstructions(matchedInstructions, earlierMatchedInstructions, remainingInstructions));
        } else {
          // ...or create the (remaining) implicit clear instructions (if any).
          matchedInstructions = clearEndpoints.map(endpoint => RoutingInstruction.createClear(router, endpoint));
        }
      }
    } while (matchedInstructions.length > 0 || remainingInstructions.length > 0);

    return allChangedEndpoints;
  }






  /**
   * Deal with/throw an unknown route error.
   *
   * @param route - The failing route
   */
  private unknownRoute(route: string) {
    if (typeof route !== 'string' || route.length === 0) {
      return;
    }
    if (this.router.configuration.options.useConfiguredRoutes && this.router.configuration.options.useDirectRouting) {
      // TODO: Add missing/unknown route handling
      throw new Error("No matching configured route or component found for '" + route + "'");
    } else if (this.router.configuration.options.useConfiguredRoutes) {
      // TODO: Add missing/unknown route handling
      throw new Error("No matching configured route found for '" + route + "'");
    } else {
      // TODO: Add missing/unknown route handling
      throw new Error("No matching route/component found for '" + route + "'");
    }
  }

  /**
   * Ensure that there's a clear all instruction present in instructions.
   */
  private ensureClearStateInstruction(instructions: RoutingInstruction[]): RoutingInstruction[] {
    const router = this.router;
    if (!instructions.some(instruction => instruction.isClearAll(router))) {
      const clearAll = RoutingInstruction.create(RoutingInstruction.clear(router)) as RoutingInstruction;
      clearAll.scope = this;
      return [clearAll, ...instructions];
    }
    return instructions;

    // if (instructions.length > 0) {
    //   const instruction = instructions[0];
    //   if (!instruction.isAddAll(this.router) && !instruction.isClearAll(this.router)) {
    //     const clearAll = RoutingInstruction.create(RoutingInstruction.clear(this.router)) as RoutingInstruction;
    //     clearAll.scope = instruction.scope;
    //     return [clearAll, ...instructions];
    //   }
    // }
    // return instructions;
  }

  /**
   * Get all endpoints affected by any clear all routing instructions and then remove those
   * routing instructions.
   *
   * @param instructions - The instructions to process
   */
  private getClearAllEndpoints(instructions: RoutingInstruction[]): { clearEndpoints: Endpoint[]; instructions: RoutingInstruction[] } {
    const router = this.router;
    let clearEndpoints: Endpoint[] = [];

    // If there's any clear all routing instruction...
    if (instructions.some(instruction => (instruction.scope ?? this) === this && instruction.isClearAll(router))) {
      // ...get all the endpoints to be cleared...
      clearEndpoints = this.enabledChildren  // TODO(alpha): Verfiy the need for rootScope check below
        .filter(scope => !scope.endpoint.isEmpty) // && scope !== this.router.rootScope?.connectedScope)
        .map(scope => scope.endpoint);
      // ...and remove the clear all instructions
      instructions = instructions.filter(instruction => !((instruction.scope ?? this) === this && instruction.isClearAll(router)));
    }
    return { clearEndpoints, instructions };
  }











  public findInstructions(instructions: RoutingInstruction[], useDirectRouting: boolean, useConfiguredRoutes: boolean): FoundRoute {
    const router = this.router;
    let route = new FoundRoute();

    if (useConfiguredRoutes && !RoutingInstruction.containsSiblings(router, instructions)) {
      let clearInstructions = instructions.filter(instruction => instruction.isClear(router) || instruction.isClearAll(router));
      const nonClearInstructions = instructions.filter(instruction => !instruction.isClear(router) && !instruction.isClearAll(router));

      // As long as the sibling constraint (above) is in, this will only be at most one instruction
      if (nonClearInstructions.length > 0) {
        for (const instruction of nonClearInstructions) {
          const foundRoute = this.findMatchingRoute(RoutingInstruction.stringify(router, nonClearInstructions));
          if (foundRoute?.foundConfiguration ?? false) {
            route = foundRoute!;
            route.instructions = [...clearInstructions, ...route.instructions];
            clearInstructions = [];
          } else if (useDirectRouting) {
            route.instructions = [...clearInstructions, ...route.instructions, instruction];
            clearInstructions = [];
            route.remaining = RoutingInstruction.stringify(router, instruction.nextScopeInstructions ?? []);
          } else {
            throw new Error(`No route found for: ${RoutingInstruction.stringify(router, instructions)}!`);
          }
        }
      } else {
        route.instructions = [...clearInstructions];
      }
    } else if (useDirectRouting) {
      route.instructions.push(...instructions);
    } else {
      throw new Error(`No way to process sibling viewport routes with direct routing disabled: ${RoutingInstruction.stringify(router, instructions)}!`);
    }

    // Remove empty instructions so that default can be used
    route.instructions = route.instructions.filter(instr => instr.component.name !== '');

    for (const instruction of route.instructions) {
      if (instruction.scope === null) {
        instruction.scope = this;
      }
    }

    return route;
  }





  // public findInstructions(instruction: string | RoutingInstruction[], useDirectRouting: boolean, useConfiguredRoutes: boolean): FoundRoute {
  //   let route = new FoundRoute();
  //   if (typeof instruction === 'string') {
  //     const instructions: RoutingInstruction[] = [];
  //     const instrs = RoutingInstruction.parse(this.router, instruction);
  //     // Make sure empty route is also processed
  //     if (instruction === '' || instruction === '-') {
  //       instrs.push(new RoutingInstruction(''));
  //     }
  //     if (useConfiguredRoutes && !RoutingInstruction.containsSiblings(this.router, instrs)) {
  //       for (const instr of instrs) {
  //         if (instr.isClear(this.router) || instr.isClearAll(this.router)) {
  //           instructions.push(instr);
  //         } else {

  //           const foundRoute = this.findMatchingRoute(RoutingInstruction.stringify(this.router, [instr]));
  //           if (foundRoute?.foundConfiguration ?? false) {
  //             route = foundRoute!;
  //             instructions.push(...route.instructions);
  //           } else {
  //             if (useDirectRouting) {
  //               // route.instructions = instructions;
  //               instructions.push(instr);
  //               // if (route.instructions.length > 0) {
  //               const nextInstructions = instr.nextScopeInstructions ?? [];
  //               route.remaining = RoutingInstruction.stringify(this.router, nextInstructions);
  //               // TODO: Verify that it's okay to leave this in
  //               instr.nextScopeInstructions = null;
  //               // }
  //             }
  //           }
  //         }
  //       }

  //     } else if (useDirectRouting) {
  //       instructions.push(...instrs);
  //     }
  //     // Remove empty instructions so that default can be used
  //     route.instructions = instructions.filter(instr => instr.component.name !== '');

  //     // const instructions = RoutingInstruction.parse(this.router, instruction);
  //     // if (useConfiguredRoutes && !RoutingInstruction.containsSiblings(this.router, instructions)) {
  //     //   const foundRoute = this.findMatchingRoute(instruction);
  //     //   if (foundRoute?.foundConfiguration ?? false) {
  //     //     route = foundRoute!;
  //     //   } else {
  //     //     if (useDirectRouting) {
  //     //       route.instructions = instructions;
  //     //       if (route.instructions.length > 0) {
  //     //         const nextInstructions = route.instructions[0].nextScopeInstructions ?? [];
  //     //         route.remaining = RoutingInstruction.stringify(this.router, nextInstructions);
  //     //         // TODO: Verify that it's okay to leave this in
  //     //         route.instructions[0].nextScopeInstructions = null;
  //     //       }
  //     //     }
  //     //   }
  //     // } else if (useDirectRouting) {
  //     //   route.instructions = instructions;
  //     // }
  //   } else {
  //     route.instructions = instruction;
  //   }

  //   for (const instr of route.instructions) {
  //     if (instr.scope === null) {
  //       instr.scope = this;
  //     }
  //   }

  //   return route;
  // }

  // Note: This can't change state other than the instructions!
  /**
   * Match the instructions to available endpoints within, and with the help of, their scope.
   *
   * @param instructions - The instructions to matched
   * @param alreadyFound - The already found matches
   * @param disregardViewports - Whether viewports should be ignored when matching
   */
  public matchEndpoints(instructions: RoutingInstruction[], alreadyFound: RoutingInstruction[], disregardViewports: boolean = false): { matchedInstructions: RoutingInstruction[]; remainingInstructions: RoutingInstruction[] } {
    const allMatchedInstructions: RoutingInstruction[] = [];
    const scopeInstructions = instructions.filter(instruction => (instruction.scope ?? this) === this);
    const allRemainingInstructions = instructions.filter(instruction => (instruction.scope ?? this) !== this);

    const { matchedInstructions, remainingInstructions } = EndpointMatcher.matchEndpoints(this, scopeInstructions, alreadyFound, disregardViewports);
    allMatchedInstructions.push(...matchedInstructions);
    allRemainingInstructions.push(...remainingInstructions);

    return { matchedInstructions: allMatchedInstructions, remainingInstructions: allRemainingInstructions };
  }

  public addEndpoint(type: string, name: string, connectedCE: IConnectedCustomElement | null, options: IViewportOptions | IViewportScopeOptions = {}): Viewport | ViewportScope {
    let endpoint: Endpoint | null = this.getOwnedScopes()
      .find(scope => scope.type === type &&
        scope.endpoint.name === name)?.endpoint ?? null;
    // Each endpoint element has its own Endpoint
    if (connectedCE != null && endpoint?.connectedCE != null && endpoint.connectedCE !== connectedCE) {
      endpoint = this.getOwnedScopes(true)
        .find(scope => scope.type === type &&
          scope.endpoint.name === name &&
          scope.endpoint.connectedCE === connectedCE)?.endpoint
        ?? null;
    }
    if (endpoint == null) {
      endpoint = type === 'Viewport'
        ? new Viewport(this.router, name, connectedCE, this.scope, !!(options as IViewportOptions).scope, options)
        : new ViewportScope(this.router, name, connectedCE, this.scope, true, null, options);
      this.addChild(endpoint.connectedScope);
    }
    if (connectedCE != null) {
      endpoint.setConnectedCE(connectedCE, options);
    }
    return endpoint as Viewport | ViewportScope;
  }

  public removeEndpoint(step: Step | null, endpoint: Endpoint, connectedCE: IConnectedCustomElement | null): boolean {
    if (((connectedCE ?? null) !== null) || endpoint.removeEndpoint(step, connectedCE)) {
      this.removeChild(endpoint.connectedScope);
      return true;
    }
    return false;
  }

  public addChild(scope: RoutingScope): void {
    if (!this.children.some(vp => vp === scope)) {
      if (scope.parent !== null) {
        scope.parent.removeChild(scope);
      }
      this.children.push(scope);
      scope.parent = this;
    }
  }
  public removeChild(scope: RoutingScope): void {
    const index = this.children.indexOf(scope);
    if (index >= 0) {
      this.children.splice(index, 1);
      scope.parent = null;
    }
  }

  public allScopes(includeDisabled: boolean = false): RoutingScope[] {
    const scopes: RoutingScope[] = includeDisabled ? this.children.slice() : this.enabledChildren;
    for (const scope of scopes.slice()) {
      scopes.push(...scope.allScopes(includeDisabled));
    }
    return scopes;
  }

  public reparentRoutingInstructions(): RoutingInstruction[] | null {
    const scopes = this.hoistedChildren
      .filter(scope => scope.routingInstruction !== null && scope.routingInstruction.component.name);
    if (!scopes.length) {
      return null;
    }
    for (const scope of scopes) {
      const childInstructions = scope.reparentRoutingInstructions();
      scope.routingInstruction!.nextScopeInstructions =
        childInstructions !== null && childInstructions.length > 0 ? childInstructions : null;
    }
    return scopes.map(scope => scope.routingInstruction!);
  }

  public getChildren(timestamp: number): RoutingScope[] {
    const contents = this.children
      .map(scope => scope.endpoint.getTimeContent(timestamp))
      .filter(content => content !== null) as EndpointContent[];
    return contents.map(content => content.connectedScope);
  }

  public getAllRoutingScopes(timestamp: number): RoutingScope[] {
    const scopes = this.getChildren(timestamp);
    for (const scope of scopes.slice()) {
      scopes.push(...scope.getAllRoutingScopes(timestamp));
    }
    return scopes;
  }

  public getOwnedRoutingScopes(timestamp: number): RoutingScope[] {
    const scopes = this.getAllRoutingScopes(timestamp)
      .filter(scope => scope.owningScope === this);
    // Hoist children to pass through scopes
    for (const scope of scopes.slice()) {
      if (scope.passThroughScope) {
        const passThrough = scopes.indexOf(scope);
        scopes.splice(passThrough, 1, ...scope.getOwnedRoutingScopes(timestamp));
      }
    }
    return arrayUnique(scopes);
  }

  public getRoutingInstructions(timestamp: number): RoutingInstruction[] | null {
    const contents = arrayUnique(
      this.getOwnedRoutingScopes(timestamp) // hoistedChildren
        .map(scope => scope.endpoint)
    )
      .map(endpoint => endpoint.getTimeContent(timestamp))
      .filter(content => content !== null) as EndpointContent[];
    const instructions = [];

    for (const content of contents) {
      const instruction = content.instruction.clone(true, false, false);
      if ((instruction.component.name ?? '') !== '') {
        instruction.nextScopeInstructions = content.connectedScope.getRoutingInstructions(timestamp);
        instructions.push(instruction);
      }
    }
    return instructions;
  }

  public getRoutingScopes(timestamp: number): RoutingScope[] | null {
    const contents = this.ownedScopes
      .map(scope => scope.endpoint.getTimeContent(timestamp))
      .filter(content => content !== null) as EndpointContent[];
    const scopes = contents.map(content => content.connectedScope);
    return scopes;
  }

  public canUnload(step: Step<boolean> | null): boolean | Promise<boolean> {
    return Runner.run(step,
      (stepParallel: Step<boolean>) => {
        return Runner.runParallel(stepParallel,
          ...this.children.map(child => child.endpoint !== null
            ? (childStep: Step<boolean>) => child.endpoint.canUnload(childStep)
            : (childStep: Step<boolean>) => child.canUnload(childStep)
          ));
      },
      (step: Step<boolean>) => (step.previousValue as boolean[]).every(result => result)) as boolean | Promise<boolean>;
  }

  public unload(step: Step<void> | null): Step<void> {
    return Runner.runParallel(step,
      ...this.children.map(child => child.endpoint !== null
        ? (childStep: Step<void>) => child.endpoint.unload(childStep)
        : (childStep: Step<void>) => child.unload(childStep)
      )) as Step<void>;
  }

  public matchScope(instructions: RoutingInstruction[], deep = false): RoutingInstruction[] {
    const matching: RoutingInstruction[] = [];

    for (const instruction of instructions) {
      if (instruction.scope === this) {
        matching.push(instruction);
      } else if (deep && instruction.hasNextScopeInstructions) {
        matching.push(...this.matchScope(instruction.nextScopeInstructions!, deep));
      }
    }
    return matching;
  }

  public findMatchingRoute(path: string): FoundRoute | null {
    if (this.isViewportScope && !this.passThroughScope) {
      return this.findMatchingRouteInRoutes(path, this.endpoint.getRoutes());
    }
    if (this.isViewport) {
      return this.findMatchingRouteInRoutes(path, this.endpoint.getRoutes());
    }

    // TODO: Match specified names here

    for (const child of this.enabledChildren) {
      const found = child.findMatchingRoute(path);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  private findMatchingRouteInRoutes(path: string, routes: Route[] | null): FoundRoute | null {
    if (!Array.isArray(routes)) {
      return null;
    }

    routes = routes.map(route => this.ensureProperRoute(route));

    const cRoutes: IConfigurableRoute[] = [];
    for (const route of routes) {
      const paths = (Array.isArray(route.path) ? route.path : [route.path]);
      for (const path of paths) {
        cRoutes.push({
          ...route,
          path,
          handler: route,
        });
        if (path !== '') {
          cRoutes.push({
            ...route,
            path: `${path}/*remainingPath`,
            handler: route,
          });
        }
      }
    }

    const found = new FoundRoute();
    if (path.startsWith('/') || path.startsWith('+')) {
      path = path.slice(1);
    }
    const recognizer = new RouteRecognizer();

    recognizer.add(cRoutes);
    const result = recognizer.recognize(path);
    if (result !== null) {
      found.match = result.endpoint.route.handler;
      found.matching = path;
      const $params = { ...result.params };
      if ($params.remainingPath !== void 0) {
        found.remaining = $params.remainingPath;
        Reflect.deleteProperty($params, 'remainingPath');
        found.matching = found.matching.slice(0, found.matching.indexOf(found.remaining));
      }
      found.params = $params;
      if (found.match.redirectTo !== null) {
        let redirectedTo = found.match.redirectTo;
        if ((found.remaining ?? '').length > 0) {
          redirectedTo += `/${found.remaining}`;
        }
        return this.findMatchingRouteInRoutes(redirectedTo, routes);
      }
    }
    if (found.foundConfiguration) {
      // clone it so config doesn't get modified
      found.instructions = RoutingInstruction.clone(found.match!.instructions as RoutingInstruction[], false, true);
      const instructions = found.instructions.slice();
      while (instructions.length > 0) {
        const instruction = instructions.shift()!;
        instruction.parameters.addParameters(found.params);
        instruction.route = found;
        if (instruction.hasNextScopeInstructions) {
          instructions.unshift(...instruction.nextScopeInstructions!);
        }
      }
      if (found.instructions.length > 0) {
        found.instructions[0].routeStart = true;
      }

      const remaining = RoutingInstruction.parse(this.router, found.remaining);
      if (remaining.length > 0) {
        let lastInstruction = found.instructions[0];
        while (lastInstruction.hasNextScopeInstructions) {
          lastInstruction = lastInstruction.nextScopeInstructions![0];
        }
        lastInstruction.nextScopeInstructions = remaining;
      }
    }
    return found;
  }

  private ensureProperRoute(route: IRoute): Route {
    if (route.id === void 0) {
      route.id = Array.isArray(route.path) ? route.path.join(',') : route.path;
    }
    if (route.instructions === void 0) {
      route.instructions = [{
        component: route.component!,
        viewport: route.viewport,
        parameters: route.parameters,
        children: route.children,
      }];
    }
    if (route.redirectTo === null) {
      route.instructions = RoutingInstruction.from(this.router, route.instructions!);
    }
    return route as Route;
  }
}
