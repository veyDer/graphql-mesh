import { SOAPLoader } from '../src';
import { fetch } from 'undici';

describe('sth', () => {
  it('s', async () => {
    const soapLoader = new SOAPLoader({
      fetch: fetch as any,
    });
    await soapLoader.loadWSDL('http://dev-aviad:8431/services/MetadataService?wsdl');
    for (const [typeName, types] of soapLoader.namespaceComplexTypesMap.entries()) {
      console.log(typeName, types);
    }
  });
});
