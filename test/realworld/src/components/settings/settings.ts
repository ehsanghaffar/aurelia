import { inject } from '@aurelia/kernel';
import { IRouter, lifecycleLogger } from '@aurelia/router';

import { UserService } from 'shared/services/user-service';
import { SharedState } from 'shared/state/shared-state';

@lifecycleLogger('settings')
@inject(UserService, SharedState, IRouter)
export class Settings {
  public constructor(
    private readonly userService: UserService,
    private readonly sharedState: SharedState,
    private readonly router: IRouter,
  ) {}

  public created() { return; }
  public beforeBind() { return; }
  public afterBindChildren() { return; }
  public beforeAttach() { return; }
  public afterAttachChildren() { return; }
  public beforeDetach() { return; }
  public afterDetachChildren() { return; }
  public beforeUnbind() { return; }
  public afterUnbindChildren() { return; }

  public update() {
    this.userService.update(this.sharedState.currentUser);
  }

  public logout() {
    this.userService.purgeAuth();
    this.router.goto('home').catch((error: Error) => { throw error; });
  }
}
