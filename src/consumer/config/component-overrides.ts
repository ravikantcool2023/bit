import R from 'ramda';
import { pickBy } from 'lodash';
import { ComponentID } from '@teambit/component-id';
import { MANUALLY_ADD_DEPENDENCY, MANUALLY_REMOVE_DEPENDENCY, OVERRIDE_COMPONENT_PREFIX } from '../../constants';
import { SourceFile } from '../component/sources';
import ComponentConfig from './component-config';
import {
  ConsumerOverridesOfComponent,
  nonPackageJsonFields,
  overridesBitInternalFields,
  overridesForbiddenFields,
} from './consumer-overrides';
import { ExtensionDataList } from './extension-data';
import { ILegacyWorkspaceConfig } from './legacy-workspace-config-interface';

// consumer internal fields should not be used in component overrides, otherwise, they might conflict upon import
export const componentOverridesForbiddenFields = [...overridesForbiddenFields, ...overridesBitInternalFields];

export type DependenciesOverridesData = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type ComponentOverridesData = DependenciesOverridesData & {
  [key: string]: any; // any package.json field should be valid here. can't be overridesSystemFields
};

type OverridesLoadRegistry = { [extId: string]: Function };

export default class ComponentOverrides {
  private overrides: ConsumerOverridesOfComponent;
  constructor(overrides: ConsumerOverridesOfComponent | null | undefined) {
    this.overrides = overrides || {};
  }
  static componentOverridesLoadingRegistry: OverridesLoadRegistry = {};
  static registerOnComponentOverridesLoading(extId, func: (id, config, legacyFiles) => any) {
    this.componentOverridesLoadingRegistry[extId] = func;
  }

  /**
   * overrides of component can be determined by three different sources.
   * 1. component-config. (bit.json/package.json of the component itself).
   *    authored normally don't have it, most imported have it, unless they choose not to write package.json/bit.json.
   * 2. consumer-config. (bit.json/package.json of the consumer when it has overrides of the component).
   * 3. model. (when the component is tagged, the overrides data is saved into the model).
   *
   * the strategy of loading them is as follows:
   * a) find the component config. (if exists)
   * b) find the overrides of workspace config matching this component. (if exists)
   * c) merge between the two. in case of conflict, the component config wins.
   *
   * the following steps are needed to find the component config
   * a) if the component config is written to the filesystem, use it
   * b) if the component config is not written, it can be for two reasons:
   * 1) it's imported and the user chose not to write package.json nor bit.json. in this case, use
   * component from the model.
   * 2) it's author. by default, the config is written into consumer-config (if not exist) on import.
   * which, in this case, use only consumer-config.
   * an exception is when an author runs `eject-conf` command to explicitly write the config, then,
   * use the component-config.
   */
  static async loadFromConsumer(
    componentId: ComponentID,
    workspaceConfig: ILegacyWorkspaceConfig,
    overridesFromModel: ComponentOverridesData | undefined,
    componentConfig: ComponentConfig,
    files: SourceFile[]
  ): Promise<ComponentOverrides> {
    // overrides from consumer-config is not relevant and should not affect imported
    let legacyOverridesFromConsumer = workspaceConfig?.getComponentConfig(componentId);

    const plainLegacy = workspaceConfig?._legacyPlainObject();
    if (plainLegacy && plainLegacy.env) {
      legacyOverridesFromConsumer = legacyOverridesFromConsumer || {};
    }

    const getFromComponent = (): ComponentOverridesData | null | undefined => {
      if (componentConfig && componentConfig.componentHasWrittenConfig) {
        return componentConfig.overrides;
      }
      // @todo: we might consider using overridesFromModel here.
      // return isAuthor ? null : overridesFromModel;
      return null;
    };
    const extensionsAddedOverrides = await runOnLoadOverridesEvent(
      this.componentOverridesLoadingRegistry,
      componentConfig.parseExtensions(),
      componentId,
      files
    );
    const mergedLegacyConsumerOverridesWithExtensions = mergeOverrides(
      legacyOverridesFromConsumer || {},
      extensionsAddedOverrides
    );
    const fromComponent = getFromComponent();
    if (!fromComponent) {
      return new ComponentOverrides(mergedLegacyConsumerOverridesWithExtensions);
    }

    const mergedOverrides = mergedLegacyConsumerOverridesWithExtensions
      ? mergeOverrides(fromComponent, mergedLegacyConsumerOverridesWithExtensions)
      : fromComponent;
    return new ComponentOverrides(mergedOverrides);
  }

  static loadFromScope(overridesFromModel: ComponentOverridesData | null | undefined = {}) {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return new ComponentOverrides(R.clone(overridesFromModel), {});
  }

  get componentOverridesData() {
    const isNotSystemField = (val, field) => !overridesBitInternalFields.includes(field);
    return R.pickBy(isNotSystemField, this.overrides);
  }

  get componentOverridesPackageJsonData() {
    const isPackageJsonField = (val, field) => !nonPackageJsonFields.includes(field);
    return R.pickBy(isPackageJsonField, this.overrides);
  }

  getEnvByType(envType): string | Record<string, any> | undefined {
    return R.path(['env', envType], this.overrides);
  }

  getComponentDependenciesWithVersion(): Record<string, any> {
    const allDeps = Object.assign(
      {},
      this.overrides.dependencies,
      this.overrides.devDependencies,
      this.overrides.peerDependencies
    );
    return this._filterForComponentWithValidVersion(allDeps);
  }
  get defaultScope() {
    return this.overrides.defaultScope;
  }

  _filterForComponentWithValidVersion(deps: Record<string, any>): Record<string, any> {
    return Object.keys(deps).reduce((acc, current) => {
      if (this._isValidVersion(deps[current]) && current.startsWith(OVERRIDE_COMPONENT_PREFIX)) {
        const component = current.replace(OVERRIDE_COMPONENT_PREFIX, '');
        acc[component] = deps[current];
      }
      return acc;
    }, {});
  }
  _isValidVersion(ver: string) {
    return ver !== MANUALLY_ADD_DEPENDENCY && ver !== MANUALLY_REMOVE_DEPENDENCY;
  }
  getIgnored(field: string): string[] {
    return R.keys(R.filter((dep) => dep === MANUALLY_REMOVE_DEPENDENCY, this.overrides[field] || {}));
  }
  getIgnoredPackages(field: string): string[] {
    const ignoredRules = this.getIgnored(field);
    return ignoredRules;
  }
  clone(): ComponentOverrides {
    return new ComponentOverrides(R.clone(this.overrides));
  }
}

function mergeOverrides(
  overrides1: ComponentOverridesData,
  overrides2: ComponentOverridesData
): ComponentOverridesData {
  // Make sure to not mutate the original object
  const result = R.clone(overrides1);
  const isObjectAndNotArray = (val) => typeof val === 'object' && !Array.isArray(val);
  Object.keys(overrides2 || {}).forEach((field) => {
    // Do not merge internal fields
    if (overridesBitInternalFields.includes(field)) {
      return; // do nothing
    }
    if (isObjectAndNotArray(overrides1[field]) && isObjectAndNotArray(overrides2[field])) {
      result[field] = Object.assign({}, overrides2[field], overrides1[field]);
    } else if (!result[field]) {
      result[field] = overrides2[field];
    }
    // when overrides1[field] is set and not an object, do not override it by overrides2
  });
  return result;
}

/**
 * Merge added overrides from many extensions
 *
 * @param {any[]} configs
 * @returns A merge results of all config
 */
function mergeExtensionsOverrides(configs: DependenciesOverridesData[]): any {
  return configs.reduce((prev, curr) => {
    return R.mergeDeepLeft(prev, curr);
  }, {});
}

/**
 * Runs all the functions from the registry and merged their results
 *
 * @param {OverridesLoadRegistry} configsRegistry
 * @returns {Promise<ComponentOverridesData>} A merge results of the added overrides by all the extensions
 */
async function runOnLoadOverridesEvent(
  configsRegistry: OverridesLoadRegistry,
  extensions: ExtensionDataList,
  id: ComponentID,
  files: SourceFile[]
): Promise<DependenciesOverridesData> {
  const extensionsAddedOverridesP = Object.keys(configsRegistry).map((extId) => {
    // TODO: only running func for relevant extensions
    const func = configsRegistry[extId];
    return func(extensions, id, files);
  });
  const extensionsAddedOverrides = await Promise.all(extensionsAddedOverridesP);
  let extensionsConfigModificationsObject = mergeExtensionsOverrides(extensionsAddedOverrides);
  const filterFunc = (val) => !R.isEmpty(val);
  extensionsConfigModificationsObject = pickBy(extensionsConfigModificationsObject, filterFunc);
  return extensionsConfigModificationsObject;
}
