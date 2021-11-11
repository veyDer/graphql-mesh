import { SOAPLoader } from '../src/SOAPLoader';
import { fetch } from 'cross-undici-fetch';
import { execute, parse, printSchema } from 'graphql';

describe('SOAP Loader', () => {
  it('should generate the schema correctly', async () => {
    const soapLoader = new SOAPLoader({
      fetch: fetch as any,
    });
    await soapLoader.fetchWSDL('https://www.w3schools.com/xml/tempconvert.asmx?WSDL');
    const schema = soapLoader.buildSchema();
    expect(printSchema(schema)).toMatchSnapshot();
  });
  it('should execute SOAP calls correctly', async () => {
    const soapLoader = new SOAPLoader({
      fetch: fetch as any,
    });
    await soapLoader.fetchWSDL('https://www.crcind.com/csp/samples/SOAP.Demo.cls?WSDL');
    const schema = soapLoader.buildSchema();
    expect(
      await execute({
        schema,
        document: parse(`
          mutation AddInteger {
            s0_SOAPDemo_SOAPDemoSoap_AddInteger(AddInteger: {
              Arg1: 1,
              Arg2: 2
            }) {
              AddIntegerResponse {
                AddIntegerResult
              }
            }
          }
        `),
      })
    ).toMatchInlineSnapshot(`
      Object {
        "data": Object {
          "s0_SOAPDemo_SOAPDemoSoap_AddInteger": Object {
            "AddIntegerResponse": Object {
              "AddIntegerResult": 3n,
            },
          },
        },
      }
    `);
  });
});
