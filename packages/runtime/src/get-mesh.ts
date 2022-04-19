import {
  GraphQLSchema,
  GraphQLResolveInfo,
  OperationTypeNode,
  GraphQLObjectType,
  print,
  SelectionSetNode,
  Kind,
  isLeafType,
  getNamedType,
  getOperationAST,
  visit,
  visitWithTypeInfo,
  TypeInfo,
  ExecutionResult,
  DocumentNode,
} from 'graphql';
import { ExecuteMeshFn, GetMeshOptions, SubscribeMeshFn } from './types';
import {
  MeshPubSub,
  KeyValueCache,
  RawSourceOutput,
  GraphQLOperation,
  SelectionSetParamOrFactory,
  SelectionSetParam,
  Logger,
  MeshTransform,
} from '@graphql-mesh/types';

import { MESH_CONTEXT_SYMBOL, MESH_API_CONTEXT_SYMBOL } from './constants';
import {
  applySchemaTransforms,
  getInterpolatedStringFactory,
  groupTransforms,
  ResolverDataBasedFactory,
  DefaultLogger,
  parseWithCache,
  printWithCache,
} from '@graphql-mesh/utils';

import { InMemoryLiveQueryStore } from '@n1ru4l/in-memory-live-query-store';
import { delegateToSchema, IDelegateToSchemaOptions, StitchingInfo, SubschemaConfig } from '@graphql-tools/delegate';
import { BatchDelegateOptions, batchDelegateToSchema } from '@graphql-tools/batch-delegate';
import { WrapQuery } from '@graphql-tools/wrap';
import {
  AggregateError,
  inspect,
  isAsyncIterable,
  isDocumentNode,
  mapAsyncIterator,
  memoize1,
  parseSelectionSet,
} from '@graphql-tools/utils';
import { enableIf, envelop, useErrorHandler, useExtendContext, useLogger, useSchema } from '@envelop/core';
import { useLiveQuery } from '@envelop/live-query';
import { CompiledQuery, compileQuery, isCompiledQuery } from 'graphql-jit';

type EnvelopPlugins = Parameters<typeof envelop>[0]['plugins'];

export interface MeshInstance<TMeshContext = any> {
  execute: ExecuteMeshFn;
  subscribe: SubscribeMeshFn;
  schema: GraphQLSchema;
  rawSources: RawSourceOutput[];
  destroy: () => void;
  pubsub: MeshPubSub;
  cache: KeyValueCache;
  logger: Logger;
  meshContext: TMeshContext;
  plugins: EnvelopPlugins;
  getEnveloped: ReturnType<typeof envelop>;
  sdkRequesterFactory: (globalContext: any) => (document: DocumentNode, variables?: any, operationContext?: any) => any;
}

const memoizedGetOperationType = memoize1((document: DocumentNode) => {
  const operationAST = getOperationAST(document, undefined);
  if (!operationAST) {
    throw new Error('Must provide document with a valid operation');
  }
  return operationAST.operation;
});

const memoizedGetEnvelopedFactory = memoize1((plugins: EnvelopPlugins) => envelop({ plugins }));

export async function getMesh<TMeshContext = any>(options: GetMeshOptions): Promise<MeshInstance<TMeshContext>> {
  const rawSources: RawSourceOutput[] = [];
  const { pubsub, cache, logger = new DefaultLogger('🕸️'), additionalEnvelopPlugins = [] } = options;

  const getMeshLogger = logger.child('GetMesh');
  getMeshLogger.debug(() => `Getting subschemas from source handlers`);
  let failed = false;
  await Promise.allSettled(
    options.sources.map(async apiSource => {
      const apiName = apiSource.name;
      const sourceLogger = logger.child(apiName);
      sourceLogger.debug(() => `Generating the schema`);
      try {
        const source = await apiSource.handler.getMeshSource();
        sourceLogger.debug(() => `The schema has been generated successfully`);

        let apiSchema = source.schema;

        sourceLogger.debug(() => `Analyzing transforms`);

        let transforms: MeshTransform[];

        const { wrapTransforms, noWrapTransforms } = groupTransforms(apiSource.transforms);

        if (!wrapTransforms?.length && noWrapTransforms?.length) {
          sourceLogger.debug(() => `${noWrapTransforms.length} bare transforms found and applying`);
          apiSchema = applySchemaTransforms(apiSchema, source as SubschemaConfig, null, noWrapTransforms);
        } else {
          transforms = apiSource.transforms;
        }

        rawSources.push({
          name: apiName,
          schema: apiSchema,
          executor: source.executor,
          transforms,
          contextVariables: source.contextVariables || [],
          handler: apiSource.handler,
          batch: 'batch' in source ? source.batch : true,
          merge: apiSource.merge,
        });
      } catch (e: any) {
        sourceLogger.error(`Failed to generate the schema \n ${e.stack || inspect(e)}`);
        failed = true;
      }
    })
  );

  if (failed) {
    throw new Error(
      `Schemas couldn't be generated successfully. Check for the logs by running Mesh with DEBUG=1 environmental variable to get more verbose output.`
    );
  }

  getMeshLogger.debug(() => `Schemas have been generated by the source handlers`);

  getMeshLogger.debug(() => `Merging schemas using the defined merging strategy.`);
  const unifiedSchema = await options.merger.getUnifiedSchema({
    rawSources,
    typeDefs: options.additionalTypeDefs,
    resolvers: options.additionalResolvers,
    transforms: options.transforms,
  });

  const liveQueryEnabled = unifiedSchema.getDirective('live') != null;

  if (!liveQueryEnabled && options.liveQueryInvalidations?.length) {
    getMeshLogger.warn(`You have to add @live directive to additionalTypeDefs to enable Live Queries
See more at https://www.graphql-mesh.com/docs/recipes/live-queries`);
  }

  const liveQueryInvalidationFactoryMap = new Map<string, ResolverDataBasedFactory<string>[]>();

  getMeshLogger.debug(() => `Building Mesh Context`);
  const meshContext: Record<string, any> = {
    pubsub,
    cache,
    logger,
    [MESH_CONTEXT_SYMBOL]: true,
  };
  getMeshLogger.debug(() => `Attaching in-context SDK, pubsub, cache and liveQueryStore to the context`);
  const sourceMap = unifiedSchema.extensions.sourceMap as Map<RawSourceOutput, GraphQLSchema>;
  await Promise.all(
    rawSources.map(async rawSource => {
      const rawSourceLogger = logger.child(`${rawSource.name}`);

      const rawSourceContext: any = {
        rawSource,
        [MESH_API_CONTEXT_SYMBOL]: true,
      };
      // TODO: Somehow rawSource reference got lost in somewhere
      let rawSourceSubSchemaConfig: SubschemaConfig;
      const stitchingInfo = unifiedSchema.extensions.stitchingInfo as StitchingInfo;
      if (stitchingInfo) {
        for (const [subschemaConfig, subschema] of stitchingInfo.subschemaMap) {
          if ((subschemaConfig as any).name === rawSource.name) {
            rawSourceSubSchemaConfig = subschema;
            break;
          }
        }
      } else {
        rawSourceSubSchemaConfig = rawSource;
      }
      const transformedSchema = sourceMap.get(rawSource);
      const rootTypes: Record<OperationTypeNode, GraphQLObjectType> = {
        query: transformedSchema.getQueryType(),
        mutation: transformedSchema.getMutationType(),
        subscription: transformedSchema.getSubscriptionType(),
      };

      rawSourceLogger.debug(() => `Generating In Context SDK`);
      for (const operationType in rootTypes) {
        const rootType: GraphQLObjectType = rootTypes[operationType];
        if (rootType) {
          rawSourceContext[rootType.name] = {};
          const rootTypeFieldMap = rootType.getFields();
          for (const fieldName in rootTypeFieldMap) {
            const rootTypeField = rootTypeFieldMap[fieldName];
            const inContextSdkLogger = rawSourceLogger.child(`InContextSDK.${rootType.name}.${fieldName}`);
            const namedReturnType = getNamedType(rootTypeField.type);
            const shouldHaveSelectionSet = !isLeafType(namedReturnType);
            rawSourceContext[rootType.name][fieldName] = ({
              root,
              args,
              context,
              info = {
                fieldName,
                fieldNodes: [],
                returnType: namedReturnType,
                parentType: rootType,
                path: {
                  typename: rootType.name,
                  key: fieldName,
                  prev: undefined,
                },
                schema: transformedSchema,
                fragments: {},
                rootValue: root,
                operation: {
                  kind: Kind.OPERATION_DEFINITION,
                  operation: operationType as OperationTypeNode,
                  selectionSet: {
                    kind: Kind.SELECTION_SET,
                    selections: [],
                  },
                },
                variableValues: {},
                cacheControl: {
                  setCacheHint: () => {},
                  cacheHint: {},
                },
              },
              selectionSet,
              key,
              argsFromKeys,
              valuesFromResults,
            }: {
              root: any;
              args: any;
              context: any;
              info: GraphQLResolveInfo;
              selectionSet: SelectionSetParamOrFactory;
              key?: string;
              argsFromKeys?: (keys: string[]) => any;
              valuesFromResults?: (result: any, keys?: string[]) => any;
            }) => {
              inContextSdkLogger.debug(
                () => `Called with
- root: ${inspect(root)}
- args: ${inspect(args)}
- key: ${inspect(key)}`
              );
              const commonDelegateOptions: IDelegateToSchemaOptions = {
                schema: rawSourceSubSchemaConfig,
                rootValue: root,
                operation: operationType as OperationTypeNode,
                fieldName,
                context,
                transformedSchema,
                info,
              };
              // If there isn't an extraction of a value
              if (typeof selectionSet !== 'function') {
                commonDelegateOptions.returnType = rootTypeField.type;
              }
              if (shouldHaveSelectionSet) {
                let selectionCount = 0;
                for (const fieldNode of info.fieldNodes) {
                  if (fieldNode.selectionSet != null) {
                    selectionCount += fieldNode.selectionSet.selections.length;
                  }
                }
                if (selectionCount === 0) {
                  if (!selectionSet) {
                    throw new Error(
                      `You have to provide 'selectionSet' for context.${rawSource.name}.${rootType.name}.${fieldName}`
                    );
                  }
                  commonDelegateOptions.info = {
                    ...info,
                    fieldNodes: [
                      {
                        ...info.fieldNodes[0],
                        selectionSet: {
                          kind: Kind.SELECTION_SET,
                          selections: [
                            {
                              kind: Kind.FIELD,
                              name: {
                                kind: Kind.NAME,
                                value: '__typename',
                              },
                            },
                          ],
                        },
                      },
                      ...info.fieldNodes.slice(1),
                    ],
                  };
                }
              }
              if (key && argsFromKeys) {
                const batchDelegationOptions = {
                  ...commonDelegateOptions,
                  key,
                  argsFromKeys,
                  valuesFromResults,
                } as unknown as BatchDelegateOptions;
                if (selectionSet) {
                  const selectionSetFactory = normalizeSelectionSetParamOrFactory(selectionSet);
                  const path = [fieldName];
                  const wrapQueryTransform = new WrapQuery(path, selectionSetFactory, identical);
                  batchDelegationOptions.transforms = [wrapQueryTransform as any];
                }
                return batchDelegateToSchema(batchDelegationOptions);
              } else {
                const regularDelegateOptions: IDelegateToSchemaOptions = {
                  ...commonDelegateOptions,
                  args,
                };
                if (selectionSet) {
                  const selectionSetFactory = normalizeSelectionSetParamOrFactory(selectionSet);
                  const path = [fieldName];
                  const wrapQueryTransform = new WrapQuery(path, selectionSetFactory, valuesFromResults || identical);
                  regularDelegateOptions.transforms = [wrapQueryTransform as any];
                }
                return delegateToSchema(regularDelegateOptions);
              }
            };
          }
        }
      }
      meshContext[rawSource.name] = rawSourceContext;
    })
  );

  const compiledQueries = new Map<string, CompiledQuery | ExecutionResult>();
  if (options.documents?.length) {
    getMeshLogger.debug(() => `Compiling operation documents`);
    for (const documentSource of options.documents || []) {
      compiledQueries.set(
        documentSource.rawSDL || printWithCache(documentSource.document),
        compileQuery(unifiedSchema, documentSource.document || parseWithCache(documentSource.rawSDL))
      );
    }
  }

  const plugins: EnvelopPlugins = [
    useSchema(unifiedSchema),
    useExtendContext(() => meshContext),
    enableIf(liveQueryEnabled, () => {
      getMeshLogger.debug(() => `Creating Live Query Store`);
      const liveQueryStore = new InMemoryLiveQueryStore({
        includeIdentifierExtension: true,
      });
      options.liveQueryInvalidations?.forEach(liveQueryInvalidation => {
        const rawInvalidationPaths = liveQueryInvalidation.invalidate;
        const factories = rawInvalidationPaths.map(rawInvalidationPath =>
          getInterpolatedStringFactory(rawInvalidationPath)
        );
        liveQueryInvalidationFactoryMap.set(liveQueryInvalidation.field, factories);
      });
      return useLiveQuery({ liveQueryStore });
    }),
    useLogger({
      logFn: (eventName, args) => logger.child(eventName).debug(() => inspect(args)),
    }),
    useErrorHandler(errors => {
      errors.forEach(error => logger.error(error.stack || error.message));
    }),
    {
      onParse({ setParseFn }) {
        setParseFn(parseWithCache);
      },
      onValidate({ params, setResult }) {
        const sdl = printWithCache(params.documentAST).trim();
        if (compiledQueries.has(sdl)) {
          setResult([]);
        }
      },
      onSubscribe({ args: subscriptionArgs, setSubscribeFn }) {
        const sdl = printWithCache(subscriptionArgs.document);
        const cacheKey = `compiled_${sdl}`;
        const compiledQuery = compiledQueries.get(cacheKey) as CompiledQuery | ExecutionResult;
        if (compiledQuery != null) {
          logger.debug(
            () =>
              `Persisted compiled query found: ${
                getOperationAST(subscriptionArgs.document, subscriptionArgs.operationName)?.name?.value
              }`
          );
          if (isCompiledQuery(compiledQuery)) {
            setSubscribeFn(
              () =>
                compiledQuery.subscribe(
                  subscriptionArgs.rootValue,
                  subscriptionArgs.contextValue,
                  subscriptionArgs.variableValues
                ) as any
            );
          }
        }
      },
      onExecute({ args: executionArgs, setResultAndStopExecution, setExecuteFn }) {
        const sdl = printWithCache(executionArgs.document);
        const cacheKey = `compiled_${sdl}`;
        const compiledQuery = compiledQueries.get(cacheKey);
        if (compiledQuery != null) {
          logger.debug(
            () =>
              `Persisted compiled query found: ${
                getOperationAST(executionArgs.document, executionArgs.operationName)?.name?.value
              }`
          );
          if (isCompiledQuery(compiledQuery)) {
            setExecuteFn(() =>
              compiledQuery.query(executionArgs.rootValue, executionArgs.contextValue, executionArgs.variableValues)
            );
          } else {
            setResultAndStopExecution(compiledQuery);
          }
        }

        if (liveQueryEnabled) {
          return {
            async onExecuteDone({ args: executionArgs, result }) {
              const { schema, document, operationName, rootValue, contextValue } = executionArgs;
              const operationAST = getOperationAST(document, operationName);
              if (!operationAST) {
                throw new Error(`Operation couldn't be found`);
              }
              const typeInfo = new TypeInfo(schema);
              visit(
                operationAST,
                visitWithTypeInfo(typeInfo, {
                  Field: () => {
                    const parentType = typeInfo.getParentType();
                    const fieldDef = typeInfo.getFieldDef();
                    const path = `${parentType.name}.${fieldDef.name}`;
                    if (liveQueryInvalidationFactoryMap.has(path)) {
                      const invalidationPathFactories = liveQueryInvalidationFactoryMap.get(path);
                      const invalidationPaths = invalidationPathFactories.map(invalidationPathFactory =>
                        invalidationPathFactory({ root: rootValue, context: contextValue, env: process.env, result })
                      );
                      executionArgs.contextValue.liveQueryStore
                        .invalidate(invalidationPaths)
                        .catch((e: Error) => logger.warn(`Invalidation failed for ${path}: ${e.message}`));
                    }
                  },
                })
              );
            },
          };
        }
        return {};
      },
    },
    ...additionalEnvelopPlugins,
  ];

  const EMPTY_ROOT_VALUE: any = {};
  const EMPTY_CONTEXT_VALUE: any = {};
  const EMPTY_VARIABLES_VALUE: any = {};

  async function meshExecute<TVariables = any, TContext = any, TRootValue = any, TData = any>(
    documentOrSDL: GraphQLOperation<TData, TVariables>,
    variableValues: TVariables = EMPTY_VARIABLES_VALUE,
    contextValue: TContext = EMPTY_CONTEXT_VALUE,
    rootValue: TRootValue = EMPTY_ROOT_VALUE,
    operationName?: string
  ) {
    const getEnveloped = memoizedGetEnvelopedFactory(plugins);
    const { execute, contextFactory, parse } = getEnveloped(contextValue);

    return execute({
      document: typeof documentOrSDL === 'string' ? parse(documentOrSDL) : documentOrSDL,
      contextValue: await contextFactory(),
      rootValue,
      variableValues: variableValues as any,
      schema: unifiedSchema,
      operationName,
    });
  }

  async function meshSubscribe<TVariables = any, TContext = any, TRootValue = any, TData = any>(
    documentOrSDL: GraphQLOperation<TData, TVariables>,
    variableValues: TVariables = EMPTY_VARIABLES_VALUE,
    contextValue: TContext = EMPTY_CONTEXT_VALUE,
    rootValue: TRootValue = EMPTY_ROOT_VALUE,
    operationName?: string
  ) {
    const getEnveloped = memoizedGetEnvelopedFactory(plugins);
    const { subscribe, contextFactory, parse } = getEnveloped(contextValue);

    return subscribe({
      document: typeof documentOrSDL === 'string' ? parse(documentOrSDL) : documentOrSDL,
      contextValue: await contextFactory(),
      rootValue,
      variableValues: variableValues as any,
      schema: unifiedSchema,
      operationName,
    });
  }

  function sdkRequesterFactory(globalContext: any) {
    return async function meshSdkRequester(document: DocumentNode, variables: any, contextValue: any) {
      if (memoizedGetOperationType(document) === 'subscription') {
        const result = await meshSubscribe(document, variables, {
          ...globalContext,
          ...contextValue,
        });
        if ('errors' in result) {
          return new AggregateError(result.errors);
        }
        if (isAsyncIterable(result)) {
          return mapAsyncIterator(result, result => result.data);
        }
        return result.data;
      } else {
        const result = await meshExecute(document, variables, {
          ...globalContext,
          ...contextValue,
        });
        if ('errors' in result) {
          return new AggregateError(result.errors);
        }
        return result.data;
      }
    };
  }

  return {
    execute: meshExecute,
    subscribe: meshSubscribe,
    schema: unifiedSchema,
    rawSources,
    cache,
    pubsub,
    destroy: () => pubsub.publish('destroy', undefined),
    logger,
    meshContext: meshContext as TMeshContext,
    plugins,
    get getEnveloped() {
      return memoizedGetEnvelopedFactory(plugins);
    },
    sdkRequesterFactory,
  };
}

function normalizeSelectionSetParam(selectionSetParam: SelectionSetParam) {
  if (typeof selectionSetParam === 'string') {
    return parseSelectionSet(selectionSetParam);
  }
  if (isDocumentNode(selectionSetParam)) {
    return parseSelectionSet(print(selectionSetParam));
  }
  return selectionSetParam;
}

function normalizeSelectionSetParamOrFactory(
  selectionSetParamOrFactory: SelectionSetParamOrFactory
): (subtree: SelectionSetNode) => SelectionSetNode {
  return function getSelectionSet(subtree: SelectionSetNode) {
    if (typeof selectionSetParamOrFactory === 'function') {
      const selectionSetParam = selectionSetParamOrFactory(subtree);
      return normalizeSelectionSetParam(selectionSetParam);
    } else {
      return normalizeSelectionSetParam(selectionSetParamOrFactory);
    }
  };
}

function identical<T>(val: T): T {
  return val;
}
