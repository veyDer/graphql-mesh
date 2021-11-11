import { SOAPLoader } from '../src';
import { fetch } from 'cross-undici-fetch';
import { execute, parse, printSchema } from 'graphql';

describe('SOAP Loader', () => {
  it('should generate an executable schema', async () => {
    const soapLoader = new SOAPLoader({
      fetch: fetch as any,
    });
    soapLoader.loadXMLSchemaNamespace();
    await soapLoader.loadWSDL('https://www.w3schools.com/xml/tempconvert.asmx?WSDL');
    soapLoader.addRootFieldsToComposer();
    const schema = soapLoader.buildSchema();
    expect(printSchema(schema)).toMatchSnapshot();
    expect(
      await execute({
        schema,
        document: parse(`
          mutation {
            tns_TempConvert_TempConvertSoap_CelsiusToFahrenheit(CelsiusToFahrenheit: { Celsius: "24" }) {
              CelsiusToFahrenheitResponse {
                CelsiusToFahrenheitResult
              }
            }
          }
        `),
      })
    ).toMatchInlineSnapshot(`
      Object {
        "data": Object {
          "tns_TempConvert_TempConvertSoap_CelsiusToFahrenheit": Object {
            "CelsiusToFahrenheitResponse": Object {
              "CelsiusToFahrenheitResult": "75.2",
            },
          },
        },
      }
    `);
  });
});
