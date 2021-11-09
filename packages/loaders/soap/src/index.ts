import { sanitizeNameForGraphQL } from '@graphql-mesh/utils';
import { parse as parseXML, X2jOptions } from 'fast-xml-parser';
import { InputTypeComposer, InputTypeComposerFieldConfigMapDefinition, SchemaComposer } from 'graphql-compose';
import { XSComplexType, WSDLDefinition, WSDLObject, WSDLPortType, WSDLBinding, WSDLMessage, XSSchema } from './types';

export interface SOAPLoaderOptions {
  fetch: WindowOrWorkerGlobalScope['fetch'];
}

const PARSE_XML_OPTIONS: Partial<X2jOptions> = {
  attributeNamePrefix: '',
  attrNodeName: 'attributes',
  textNodeName: 'innerText',
  ignoreAttributes: false,
  ignoreNameSpace: false,
  arrayMode: true,
  allowBooleanAttributes: true,
};

export class SOAPLoader {
  private schemaComposer = new SchemaComposer();
  private namespaceDefinitionsMap = new Map<string, WSDLDefinition[]>();
  private namespaceComplexTypesMap = new Map<string, Map<string, XSComplexType>>();
  private namespacePortTypesMap = new Map<string, Map<string, WSDLPortType>>();
  private namespaceBindingMap = new Map<string, Map<string, WSDLBinding>>();
  private namespaceMessageMap = new Map<string, Map<string, WSDLMessage>>();
  private aliasMap = new WeakMap<any, Map<string, string>>();
  private messageInputTCMap = new WeakMap<WSDLMessage, InputTypeComposer>();
  private complexTypeInputTCMap = new WeakMap<XSComplexType, InputTypeComposer>();
  private namespaceTypePrefixMap = new Map<string, string>();

  constructor(private options: SOAPLoaderOptions) {}
  private getNamespaceDefinitions(namespace: string) {
    let namespaceDefinitions = this.namespaceDefinitionsMap.get(namespace);
    if (!namespaceDefinitions) {
      namespaceDefinitions = [];
      this.namespaceDefinitionsMap.set(namespace, namespaceDefinitions);
    }
    return namespaceDefinitions;
  }

  private getNamespaceComplexTypeMap(namespace: string) {
    let namespaceComplexTypes = this.namespaceComplexTypesMap.get(namespace);
    if (!namespaceComplexTypes) {
      namespaceComplexTypes = new Map();
      this.namespaceComplexTypesMap.set(namespace, namespaceComplexTypes);
    }
    return namespaceComplexTypes;
  }

  private getNamespacePortTypeMap(namespace: string) {
    let namespacePortTypes = this.namespacePortTypesMap.get(namespace);
    if (!namespacePortTypes) {
      namespacePortTypes = new Map();
      this.namespacePortTypesMap.set(namespace, namespacePortTypes);
    }
    return namespacePortTypes;
  }

  private getNamespaceBindingMap(namespace: string) {
    let namespaceBindingMap = this.namespaceBindingMap.get(namespace);
    if (!namespaceBindingMap) {
      namespaceBindingMap = new Map();
      this.namespaceBindingMap.set(namespace, namespaceBindingMap);
    }
    return namespaceBindingMap;
  }

  private getNamespaceMessageMap(namespace: string) {
    let namespaceMessageMap = this.namespaceMessageMap.get(namespace);
    if (!namespaceMessageMap) {
      namespaceMessageMap = new Map();
      this.namespaceMessageMap.set(namespace, namespaceMessageMap);
    }
    return namespaceMessageMap;
  }

  async loadWSDL(location: string) {
    const response = await this.options.fetch(location);
    const wsdlText = await response.text();
    const wsdlObject: WSDLObject = parseXML(wsdlText, PARSE_XML_OPTIONS);
    for (const definition of wsdlObject['wsdl:definitions']) {
      this.getNamespaceDefinitions(definition.attributes.targetNamespace).push(definition);
      this.namespaceTypePrefixMap.set(definition.attributes.targetNamespace, definition.attributes.name);
      if (definition['wsdl:import']) {
        for (const importObj of definition['wsdl:import']) {
          if (importObj.attributes.location) {
            await this.loadWSDL(importObj.attributes.location);
          }
        }
      }
      if (definition['wsdl:types']) {
        for (const typesObj of definition['wsdl:types']) {
          for (const schemaObj of typesObj['xs:schema']) {
            const namespace = schemaObj.attributes.targetNamespace;
            const aliasMap = this.getAliasMapFromAttributes(schemaObj.attributes);
            const namespaceComplexTypes = this.getNamespaceComplexTypeMap(namespace);
            for (const complexType of schemaObj['xs:complexType']) {
              namespaceComplexTypes.set(complexType.attributes.name, complexType);
              this.aliasMap.set(complexType, aliasMap);
            }
          }
        }
      }
      const definitionAliasMap = this.getAliasMapFromAttributes(definition.attributes);
      if (definition['wsdl:portType']) {
        const namespacePortTypes = this.getNamespacePortTypeMap(definition.attributes.targetNamespace);
        for (const portTypeObj of definition['wsdl:portType']) {
          namespacePortTypes.set(portTypeObj.attributes.name, portTypeObj);
          this.aliasMap.set(portTypeObj, definitionAliasMap);
        }
      }
      if (definition['wsdl:binding']) {
        const namespaceBindingMap = this.getNamespaceBindingMap(definition.attributes.targetNamespace);
        for (const bindingObj of definition['wsdl:binding']) {
          namespaceBindingMap.set(bindingObj.attributes.name, bindingObj);
          this.aliasMap.set(bindingObj, definitionAliasMap);
        }
      }
      if (definition['wsdl:message']) {
        const namespaceMessageMap = this.getNamespaceMessageMap(definition.attributes.targetNamespace);
        for (const messageObj of definition['wsdl:message']) {
          namespaceMessageMap.set(messageObj.attributes.name, messageObj);
          this.aliasMap.set(messageObj, definitionAliasMap);
        }
      }
    }
  }

  getAliasMapFromAttributes(attributes: XSSchema['attributes'] | WSDLDefinition['attributes']) {
    const aliasMap = new Map<string, string>();
    for (const attributeName in attributes) {
      if (attributeName.startsWith('xmlns:')) {
        const alias = attributeName.split('xmlns:')[1];
        aliasMap.set(alias, attributes[attributeName]);
      }
    }
    return aliasMap;
  }

  getInputTypeForTypeNameInNamespace({ typeName, typeNamespace }: { typeName: string; typeNamespace: string }) {
    const complexType = this.getNamespaceComplexTypeMap(typeNamespace)?.get(typeName);
    if (complexType) {
      return this.getInputTypeForComplexType(complexType, typeNamespace);
    }
    throw new Error(`Type: ${typeName} couldn't be found in ${typeNamespace}`);
  }

  getInputTypeForComplexType(complexType: XSComplexType, complexTypeNamespace: string) {
    let complexTypeTC = this.complexTypeInputTCMap.get(complexType);
    if (!complexTypeTC) {
      const complexTypeName = complexType.attributes.name;
      const prefix = this.namespaceTypePrefixMap.get(complexTypeNamespace);
      complexTypeTC = this.schemaComposer.createInputTC({
        name: `${prefix}_${complexTypeName}_Input`,
        fields: () => {
          const aliasMap = this.aliasMap.get(complexType);
          const fieldMap: InputTypeComposerFieldConfigMapDefinition = {};
          for (const sequenceObj of complexType['xs:sequence']) {
            for (const elementObj of sequenceObj['xs:element']) {
              const [typeNamespaceAlias, typeName] = elementObj.attributes.type.split(':');
              const typeNamespace = aliasMap.get(typeNamespaceAlias);
              if (!typeNamespace) {
                throw new Error(`Namespace alias: ${typeNamespace} is undefined!`);
              }
              fieldMap[elementObj.attributes.name] = {
                type: this.getInputTypeForTypeNameInNamespace({ typeName, typeNamespace }),
              };
            }
          }
          for (const complexContentObj of complexType['xs:complexContent']) {
            for (const extensionObj of complexContentObj['xs:extension']) {
              const [baseTypeNamespaceAlias, baseTypeName] = extensionObj.attributes.base.split(':');
              const baseTypeNamespace = aliasMap.get(baseTypeNamespaceAlias);
              if (!baseTypeNamespace) {
                throw new Error(`Namespace alias: ${baseTypeNamespace} is undefined!`);
              }
              const baseTypeTC = this.getInputTypeForTypeNameInNamespace({
                typeName: baseTypeName,
                typeNamespace: baseTypeNamespace,
              });
              for (const fieldName in baseTypeTC.getFields()) {
                fieldMap[fieldName] = baseTypeTC.getField(fieldName);
              }
              for (const sequenceObj of extensionObj['xs:sequence']) {
                for (const elementObj of sequenceObj['xs:element']) {
                  const [typeNamespaceAlias, typeName] = elementObj.attributes.type.split(':');
                  const typeNamespace = aliasMap.get(typeNamespaceAlias);
                  if (!typeNamespace) {
                    throw new Error(`Namespace alias: ${typeNamespace} is undefined!`);
                  }
                  fieldMap[elementObj.attributes.name] = {
                    type: this.getInputTypeForTypeNameInNamespace({ typeName, typeNamespace }),
                  };
                }
              }
            }
          }
          return fieldMap;
        },
      });
    }
    return complexTypeTC;
  }

  getInputTypeForMessage(message: WSDLMessage, messageNamespace: string) {
    let inputTC = this.messageInputTCMap.get(message);
    if (!inputTC) {
      const messageName = message.attributes.name;
      const prefix = this.namespaceTypePrefixMap.get(messageNamespace);
      const inputTCName = sanitizeNameForGraphQL(`${prefix}_${messageName}_Input`);
      inputTC = this.schemaComposer.createInputTC({
        name: inputTCName,
        fields: () => {
          const fieldMap: InputTypeComposerFieldConfigMapDefinition = {};
          const aliasMap = this.aliasMap.get(message);
          for (const part of message['wsdl:part']) {
            const partName = part.attributes.name;
            const [typeNamespaceAlias, typeName] = part.attributes.element.split(':');
            const typeNamespace = aliasMap.get(typeNamespaceAlias);
            if (!typeNamespace) {
              throw new Error(`Namespace alias: ${typeNamespace} is undefined!`);
            }
            fieldMap[partName] = {
              type: this.getInputTypeForTypeNameInNamespace({ typeName, typeNamespace }),
            };
          }
          return fieldMap;
        },
      });
      this.messageInputTCMap.set(message, inputTC);
    }
    return inputTC;
  }

  build() {
    for (const [_namespace, definitions] of this.namespaceDefinitionsMap) {
      // const prefix = this.namespaceTypePrefixMap.get(namespace);
      for (const definition of definitions) {
        const serviceAndPortAliasMap = this.getAliasMapFromAttributes(definition.attributes);
        if (definition['wsdl:service']) {
          for (const serviceObj of definition['wsdl:service']) {
            const serviceName = serviceObj.attributes.name;
            for (const portObj of serviceObj['wsdl:port']) {
              const portName = portObj.attributes.name;
              const [bindingNamespaceAlias, bindingName] = portObj.attributes.binding.split(':');
              const bindingNamespace = serviceAndPortAliasMap.get(bindingNamespaceAlias);
              if (!bindingNamespace) {
                throw new Error(`Namespace alias: ${bindingNamespaceAlias} is undefined!`);
              }
              const bindingObj = this.getNamespaceBindingMap(bindingNamespace).get(bindingName);
              if (!bindingObj) {
                throw new Error(
                  `Binding: ${bindingName} is not defined in ${bindingNamespace} needed for ${serviceName}->${portName}`
                );
              }
              const bindingAliasMap = this.aliasMap.get(bindingObj);
              if (!bindingAliasMap) {
                throw new Error(`Namespace alias definitions couldn't be found for ${bindingName}`);
              }
              const [portTypeNamespaceAlias, portTypeName] = bindingObj.attributes.type.split(':');
              const portTypeNamespace = bindingAliasMap.get(portTypeNamespaceAlias);
              if (!portTypeNamespace) {
                throw new Error(`Namespace alias: ${portTypeNamespace} is undefined!`);
              }
              const portTypeObj = this.getNamespacePortTypeMap(portTypeNamespace).get(portTypeName);
              if (!portTypeObj) {
                throw new Error(
                  `Port Type: ${portTypeName} is not defined in ${portTypeNamespace} needed for ${bindingNamespaceAlias}->${bindingName}`
                );
              }
              const portTypeAliasMap = this.aliasMap.get(portTypeObj);
              for (const operationObj of portTypeObj['wsdl:operation']) {
                const operationName = operationObj.attributes.name;
                const inputTypes = new Set<InputTypeComposer>();
                for (const inputObj of operationObj['wsdl:input']) {
                  const [messageNamespaceAlias, messageName] = inputObj.attributes.message.split(':');
                  const messageNamespace = portTypeAliasMap.get(messageNamespaceAlias);
                  if (!messageNamespace) {
                    throw new Error(`Namespace alias: ${messageNamespace} is undefined!`);
                  }
                  const messageObj = this.getNamespaceMessageMap(messageNamespace).get(messageName);
                  if (!messageObj) {
                    throw new Error(
                      `Message: ${messageName} is not defined in ${messageNamespace} needed for ${portTypeName}->${operationName}`
                    );
                  }
                  const messageInputTC = this.getInputTypeForMessage(messageObj, messageNamespace);
                  inputTypes.add(messageInputTC);
                }
              }
            }
          }
        }
      }
    }
  }
}
