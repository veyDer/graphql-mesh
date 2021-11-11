import { GetMeshSourceOptions, MeshHandler, YamlConfig, KeyValueCache } from '@graphql-mesh/types';
import { getCachedFetch } from '@graphql-mesh/utils';
import { PredefinedProxyOptions, StoreProxy } from '@graphql-mesh/store';
import { WSDLObject, XSDObject, SOAPLoader } from '@omnigraph/soap';

export default class SoapHandler implements MeshHandler {
  private config: YamlConfig.SoapHandler;
  private cache: KeyValueCache;
  private soapLocationCache: StoreProxy<[string, WSDLObject | XSDObject][]>;

  constructor({ config, baseDir, cache, store, importFn, logger }: GetMeshSourceOptions<YamlConfig.SoapHandler>) {
    this.config = config;
    this.cache = cache;
    this.soapLocationCache = store.proxy('soapLocationCache.json', PredefinedProxyOptions.JsonWithoutValidation);
  }

  async getMeshSource() {
    const soapLocationCacheEntries = await this.soapLocationCache.get();
    const soapLoader = new SOAPLoader({
      fetch: getCachedFetch(this.cache),
    });
    if (soapLocationCacheEntries) {
      for (const [location, object] of soapLocationCacheEntries) {
        soapLoader.loadedLocations.set(location, object);
        if ('schema' in object) {
          for (const schemaObj of object.schema) {
            await soapLoader.loadSchema(schemaObj);
          }
        }
        if ('definitions' in object) {
          for (const definitionObj of object.definitions) {
            await soapLoader.loadDefinition(definitionObj);
          }
        }
      }
    } else {
      await soapLoader.fetchWSDL(this.config.wsdl);
    }
    return {
      schema: soapLoader.buildSchema(),
    };
  }
}
