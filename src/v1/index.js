/** *****************************************************************************
 * Licensed Materials - Property of IBM
 * (c) Copyright IBM Corporation 2018, 2019. All Rights Reserved.
 *
 * Note to U.S. Government Users Restricted Rights:
 * Use, duplication or disclosure restricted by GSA ADP Schedule
 * Contract with IBM Corp.
 ****************************************************************************** */

import express from 'express';
import { graphqlExpress, graphiqlExpress } from 'apollo-server-express';
import { isInstance as isApolloErrorInstance, formatError as formatApolloError } from 'apollo-errors';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { app as inspect } from './lib/inspect';
import requestLib from './lib/request';
import authMiddleware from './lib/auth-middleware';

import logger from './lib/logger';

import KubeConnector from './connectors/kube';

import ClusterModel from './models/cluster';
import PlacementModel from './models/placement';
import GenericModel from './models/generic';
import QueryModel from './models/userquery';
import ComplianceModel from './models/compliance';
import ResourceViewModel from './models/resourceview';
import SAModel from './models/sa';

import schema from './schema/';
import config from '../../config';

export const GRAPHQL_PATH = `${config.get('contextPath')}/graphql`;
export const GRAPHIQL_PATH = `${config.get('contextPath')}/graphiql`;

const isProd = config.get('NODE_ENV') === 'production';
const isTest = config.get('NODE_ENV') === 'test';
const authConfig = require('./config/config');

const formatError = (error) => {
  const { originalError } = error;
  if (isApolloErrorInstance(originalError)) {
    logger.error(JSON.stringify(error.originalError, null, 2));
  }
  return formatApolloError(error);
};

async function getNamespaces(username, usertoken) {
  const options = {
    url: `${authConfig.ocp.apiserver_url}/apis/project.openshift.io/v1/projects`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${usertoken}`,
    },
    json: true,
    fullResponse: false,
  };
  return requestLib(options);
}

const graphQLServer = express();
graphQLServer.use(compression());

const requestLogger = isProd ?
  morgan('combined', {
    skip: (req, res) => res.statusCode < 400,
  })
  : morgan('dev');

graphQLServer.use('*', helmet({// These headers are dealt with in icp-management-ingress
  frameguard: false,
  noSniff: false,
  xssFilter: false,
  noCache: true,
}), requestLogger, cookieParser());

graphQLServer.get('/livenessProbe', (req, res) => {
  res.send(`Testing livenessProbe --> ${new Date().toLocaleString()}`);
});

graphQLServer.get('/readinessProbe', (req, res) => {
  res.send(`Testing readinessProbe --> ${new Date().toLocaleString()}`);
});

const auth = [];

if (!isTest) {
  auth.push(inspect);
} else {
  auth.push(authMiddleware({ shouldLocalAuth: true }));
}
if (!isProd) {
  graphQLServer.use(GRAPHIQL_PATH, graphiqlExpress({ endpointURL: GRAPHQL_PATH }));
}

if (isTest) {
  logger.info('Running in mock mode');
}

graphQLServer.use(...auth);
graphQLServer.use(GRAPHQL_PATH, bodyParser.json(), graphqlExpress(async (req) => {
  let namespaces;
  if (isTest) {
    namespaces = req.user.namespaces.map(ns => ns.namespaceId);
  } else {
    const nsPromise = await getNamespaces(req.user.username, req.cookies['acm-access-token-cookie']);
    const nsMap = nsPromise.items;
    namespaces = nsMap.map(ns => ns.metadata.name);
  }
  const kubeConnector = new KubeConnector({
    token: `Bearer ${req.cookies['acm-access-token-cookie']}`,
    namespaces,
  });
  if (isTest) {
    kubeConnector.kubeApiEndpoint = 'http://0.0.0.0/kubernetes';
  }

  const context = {
    req,
    clusterModel: new ClusterModel({ kubeConnector }),
    PlacementModel: new PlacementModel({ kubeConnector }),
    genericModel: new GenericModel({ kubeConnector }),
    queryModel: new QueryModel({ kubeConnector, req }),
    complianceModel: new ComplianceModel({ kubeConnector }),
    resourceViewModel: new ResourceViewModel({ kubeConnector }),
    saModel: new SAModel({ kubeConnector, req }),
  };

  return { formatError, schema, context };
}));

export default graphQLServer;
