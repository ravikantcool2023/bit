import { CLIAspect, CLIMain, MainRuntime } from '@teambit/cli';
import { SlotRegistry, Slot } from '@teambit/harmony';
import GlobalConfigAspect, { GlobalConfigMain } from '@teambit/global-config';
import ScopeAspect, { ScopeMain } from '@teambit/scope';
import { ComponentID } from '@teambit/component-id';
import IpcEventsAspect, { IpcEventsMain } from '@teambit/ipc-events';
import { Logger, LoggerAspect, LoggerMain } from '@teambit/logger';
import { PubsubAspect, PubsubMain } from '@teambit/pubsub';
import WorkspaceAspect, { Workspace } from '@teambit/workspace';
import pMapSeries from 'p-map-series';
import { WatchCommand } from './watch.cmd';
import { Watcher, WatchOptions } from './watcher';
import { WatcherAspect } from './watcher.aspect';

export type OnPreWatch = (componentIds: ComponentID[], watchOpts: WatchOptions) => Promise<void>;
export type OnPreWatchSlot = SlotRegistry<OnPreWatch>;

export class WatcherMain {
  constructor(
    private workspace: Workspace,
    private scope: ScopeMain,
    private pubsub: PubsubMain,
    private onPreWatchSlot: OnPreWatchSlot,
    readonly ipcEvents: IpcEventsMain,
    readonly logger: Logger,
    readonly globalConfig: GlobalConfigMain
  ) {}

  async watch(opts: WatchOptions) {
    const watcher = new Watcher(this.workspace, this.pubsub, this, opts);
    await watcher.watch();
  }

  async watchScopeInternalFiles() {
    await this.scope.watchScopeInternalFiles();
  }

  async triggerOnPreWatch(componentIds: ComponentID[], watchOpts: WatchOptions) {
    const preWatchFunctions = this.onPreWatchSlot.values();
    await pMapSeries(preWatchFunctions, async (func) => {
      await func(componentIds, watchOpts);
    });
  }

  registerOnPreWatch(onPreWatchFunc: OnPreWatch) {
    this.onPreWatchSlot.register(onPreWatchFunc);
    return this;
  }

  static slots = [Slot.withType<OnPreWatch>()];
  static dependencies = [
    CLIAspect,
    WorkspaceAspect,
    ScopeAspect,
    PubsubAspect,
    LoggerAspect,
    IpcEventsAspect,
    GlobalConfigAspect,
  ];
  static runtime = MainRuntime;

  static async provider(
    [cli, workspace, scope, pubsub, loggerMain, ipcEvents, globalConfig]: [
      CLIMain,
      Workspace,
      ScopeMain,
      PubsubMain,
      LoggerMain,
      IpcEventsMain,
      GlobalConfigMain
    ],
    _,
    [onPreWatchSlot]: [OnPreWatchSlot]
  ) {
    const logger = loggerMain.createLogger(WatcherAspect.id);
    const watcherMain = new WatcherMain(workspace, scope, pubsub, onPreWatchSlot, ipcEvents, logger, globalConfig);
    const watchCmd = new WatchCommand(pubsub, logger, watcherMain);
    cli.register(watchCmd);
    return watcherMain;
  }
}

WatcherAspect.addRuntime(WatcherMain);

export default WatcherMain;
