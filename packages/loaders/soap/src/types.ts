export interface WSDLDefinitionAttributes {
  name: string;
  targetNamespace: string;
}

export interface WSDLDefinition {
  attributes: WSDLDefinitionAttributes;
  'wsdl:import'?: WSDLImport[];
  'wsdl:service'?: WSDLService[];
  'wsdl:binding'?: WSDLBinding[];
  'wsdl:types'?: WSDLTypes[];
  'wsdl:message'?: WSDLMessage[];
  'wsdl:portType'?: WSDLPortType[];
}

export interface WSDLPortTypeAttributes {
  name: string;
}

export interface WSDLPortType {
  attributes: WSDLPortTypeAttributes;
  'wsdl:operation': WSDLOperation[];
}

export interface WSDLMessageAttributes {
  name: string;
}

export interface WSDLPartAttributes {
  element: string;
  name: string;
}

export interface WSDLPart {
  attributes: WSDLPartAttributes;
}

export interface WSDLMessage {
  attributes: WSDLMessageAttributes;
  'wsdl:part': WSDLPart[];
}

export interface XSSchemaAttributes {
  targetNamespace: string;
  version: string;
}

export interface XSSchema {
  attributes: XSSchemaAttributes;
  'xs:complexType': XSComplexType[];
}

export interface XSComplexTypeAttributes {
  name: string;
}

export interface XSElementAttributes {
  name: string;
  type: string;
}

export interface XSElement {
  attributes: XSElementAttributes;
}

export interface XSSequence {
  'xs:element': XSElement[];
}

export interface XSExtensionAttributes {
  base: string;
}

export interface XSExtension {
  attributes: XSExtensionAttributes;
  'xs:sequence': XSSequence[];
}

export interface XSComplexContent {
  'xs:extension': XSExtension[];
}

export interface XSComplexType {
  attributes: XSComplexTypeAttributes;
  'xs:complexContent': XSComplexContent[];
  'xs:sequence': XSSequence[];
}

export interface WSDLTypes {
  'xs:schema': XSSchema[];
}

export interface WSDLBindingAttributes {
  name: string;
  type: string;
}

export interface SOAPBindingAttributes {
  style: 'document';
  transport: string;
}

export interface SOAPBinding {
  attributes: SOAPBindingAttributes;
}

export interface WSDLBinding {
  attributes: WSDLBindingAttributes;
  'soap12:binding': SOAPBinding;
  'wsdl:operation': WSDLOperation[];
}

export interface WSDLOperationAttributes {
  name: string;
}

export interface SOAPOperationAttributes {
  soapAction: string;
  style: string;
}

export interface SOAPOperation {
  attributes: SOAPOperationAttributes;
}

export interface WSDLInputAttributes {
  name: string;
  message: string;
}

export interface SOAPBodyAttributes {
  use: string;
}

export interface SOAPBody {
  attributes: SOAPBodyAttributes;
}

export interface WSDLInput {
  attributes: WSDLInputAttributes;
  'soap12:body': SOAPBody[];
}

export interface WSDLOutputAttributes {
  name: string;
  message: string;
}

export interface WSDLOutput {
  attributes: WSDLOutputAttributes;
  'soap12:body': SOAPBody[];
}

export interface WSDLFaultAttributes {
  name: string;
}

export interface SOAPFault {
  attributes: SOAPFaultAttributes;
}

export interface SOAPFaultAttributes {
  name: string;
  use: string;
}

export interface WSDLFault {
  attributes: WSDLFaultAttributes;
  'soap12:fault': SOAPFault[];
}

export interface WSDLOperation {
  attributes: WSDLOperationAttributes;
  'soap12:operation'?: SOAPOperation[];
  'wsdl:input': WSDLInput[];
  'wsdl::output': WSDLOutput[];
  'wsdl:fault': WSDLFault[];
}

export interface WSDLServiceAttributes {
  name: string;
}

export interface WSDLService {
  attributes: WSDLServiceAttributes;
  'wsdl:port': WSDLPort[];
}

export interface WSDLPortAttributes {
  binding: string;
  name: string;
}

export interface WSDLPort {
  attributes: WSDLPortAttributes;
  'wsdl:address': WSDLAddress[];
}

export interface WSDLAddressAttributes {
  location: string;
}

export interface WSDLAddress {
  attributes: WSDLAddressAttributes;
}

export interface WSDLImportAttributes {
  location?: string;
  namespace: string;
}

export interface WSDLImport {
  attributes: WSDLImportAttributes;
}

export interface WSDLObject {
  'wsdl:definitions': WSDLDefinition[];
}
