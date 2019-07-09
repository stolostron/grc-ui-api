/* eslint-disable no-restricted-syntax */
/** *****************************************************************************
 * Licensed Materials - Property of IBM
 * (c) Copyright IBM Corporation 2018. All Rights Reserved.
 *
 * Note to U.S. Government Users Restricted Rights:
 * Use, duplication or disclosure restricted by GSA ADP Schedule
 * Contract with IBM Corp.
 ****************************************************************************** */

import _ from 'lodash';
import logger from '../lib/logger';
import config from '../../../config';

const POLICY_FAILURE_STATUS = 'Failure';

function getTemplates(policy = {}, templateType = '') {
  const templates = [];
  Object.entries(policy.spec || []).forEach(([key, value]) => {
    if (key.endsWith(`${templateType}-templates`)) {
      value.forEach(item => templates.push({ ...item, templateType: key }));
    }
  });
  return templates;
}

function createStatusResult(data) {
  const map = new Map();
  data.forEach((item) => {
    const { name, status } = item;
    if (!map.has(name)) {
      map.set(name, { name, total: 0, violated: 0 });
    }
    const exist = map.get(name);
    const { total, violated } = exist;
    map.set(name, { name, total: total + 1, violated: violated + (status === 'compliant' ? 0 : 1) });
  });
  return [...map.values()];
}

export default class ComplianceModel {
  constructor({ kubeConnector }) {
    if (!kubeConnector) {
      throw new Error('kubeConnector is a required parameter');
    }

    this.kubeConnector = kubeConnector;
  }


  async createPolicy(resources) {
    // TODO: revist this, do something like application,
    // combine policy and compliance into one mutation
    let errorMessage = '';
    const result = await Promise.all(resources.map((resource) => {
      const namespace = _.get(resource, 'metadata.namespace', (config.get('complianceNamespace') || 'mcm'));
      return this.kubeConnector.post(`/apis/policy.mcm.ibm.com/v1alpha1/namespaces/${namespace}/policies`, resource)
        .catch(err => Error(err));
    }));
    result.forEach((item) => {
      if (item.code >= 400 || item.status === POLICY_FAILURE_STATUS) {
        errorMessage += `${item.message}\n`;
      }
    });
    if (errorMessage) {
      throw new Error(errorMessage);
    } else {
      // TODO: add partical errors
      return result;
    }
  }


  async createCompliance(resources) {
    let errorMessage = '';
    const result = await Promise.all(resources.map((resource) => {
      const namespace = _.get(resource, 'metadata.namespace', (config.get('complianceNamespace') || 'mcm'));
      return this.kubeConnector.post(`/apis/compliance.mcm.ibm.com/v1alpha1/namespaces/${namespace}/compliances`, resource)
        .catch(err => Error(err));
    }));
    result.forEach((item) => {
      if (item.code >= 400 || item.status === POLICY_FAILURE_STATUS) {
        errorMessage += `${item.message}\n`;
      }
    });
    if (errorMessage) {
      throw new Error(errorMessage);
    } else {
      // TODO: add partical errors
      return result;
    }
  }


  async deletePolicy(input) {
    const response = await this.kubeConnector.delete(`/apis/policy.mcm.ibm.com/v1alpha1/namespaces/${input.namespace}/policies/${input.name}`);
    if (response.code || response.message) {
      throw new Error(`MCM ERROR ${response.code} - ${response.message}`);
    }
    return response.metadata.name;
  }


  async deleteCompliance(input) {
    const response = await this.kubeConnector.delete(input.selfLink);
    if (response.code || response.message) {
      throw new Error(`GRC ERROR ${response.code} - ${response.message}`);
    }
    const errors = await this.deleteComplianceResource(input.resources);
    if (errors && errors.length > 0) {
      throw new Error(`GRC ERROR: Unable to delete application resource(s) - ${JSON.stringify(errors)}`);
    }
    return response.metadata.name;
  }

  async deleteComplianceResource(resources = []) {
    if (resources.length < 1) {
      logger.info('No Compliance resources selected for deletion');
      return [];
    }

    const result = await Promise.all(resources.map(resource =>
      this.kubeConnector.delete(resource.selfLink)
        .catch(err => ({
          status: 'Failure',
          message: err.message,
        }))));

    const errors = [];
    result.forEach((item) => {
      if (item.code >= 400 || item.status === 'Failure') {
        errors.push({ message: item.message });
      }
    });

    return errors;
  }

  async getCompliances(name, namespace) {
    let compliancesAndPolicies = [];
    let compliances = [];
    let policies = [];

    if (!name) {
      // for getting compliance list
      const complianceResponse = await this.kubeConnector.get(`/apis/compliance.mcm.ibm.com/v1alpha1/namespaces/${namespace || config.get('complianceNamespace') || 'mcm'}/compliances`);
      if (complianceResponse.code || complianceResponse.message) {
        logger.error(`GRC ERROR ${complianceResponse.code} - ${complianceResponse.message}`);
      }
      compliances = complianceResponse.items || [];
      // for getting policy list
      const policyResponse = await this.kubeConnector.get(`/apis/policy.mcm.ibm.com/v1alpha1/namespaces/${namespace || config.get('complianceNamespace') || 'mcm'}/policies`);
      if (policyResponse.code || policyResponse.message) {
        logger.error(`GRC ERROR ${policyResponse.code} - ${policyResponse.message}`);
      }
      policies = policyResponse.items || [];
    } else {
      // get single compliance with a specific name - walkaround of no type field
      const complianceResponse = await this.kubeConnector.get(`/apis/compliance.mcm.ibm.com/v1alpha1/namespaces/${namespace || config.get('complianceNamespace') || 'mcm'}/compliances/${name}`);
      if (complianceResponse.code || complianceResponse.message || typeof (complianceResponse) === 'string') {
        logger.error(`GRC ERROR ${complianceResponse.code} - ${complianceResponse.message} - ${complianceResponse}`);
      } else {
        compliances.push(complianceResponse);
      }
      // get single policy with a specific name - walkaround of no type field
      const policyResponse = await this.kubeConnector.get(`/apis/policy.mcm.ibm.com/v1alpha1/namespaces/${namespace || config.get('policyNamespace') || 'mcm'}/policies/${name}`);
      if (policyResponse.code || policyResponse.message) {
        logger.error(`GRC ERROR ${policyResponse.code} - ${policyResponse.message}`);
      } else {
        policies.push(policyResponse);
      }
    }
    compliancesAndPolicies = compliances.concat(policies);
    return compliancesAndPolicies.map(entry => ({
      ...entry,
      raw: entry,
      name: _.get(entry, 'metadata.name', ''),
      namespace: _.get(entry, 'metadata.namespace', ''),
      remediation: _.get(entry, 'spec.remediationAction', ''),
      clusters: _.keys(_.get(entry, 'status.status'), ''),
    }));
  }


  static resolveCompliancePolicies(parent) {
    const aggregatedStatus = _.get(parent, 'status.status');
    // compliance that has aggregatedStatus
    if (aggregatedStatus) return this.resolvePolicyFromStatus(aggregatedStatus, parent);
    // in this case, a compliance doesn't connect with a
    // placementPolicy may not have aggregatedStatus
    return this.resolvePolicyFromSpec(parent);
  }

  static resolveCompliancePolicy(parent) {
    const aggregatedStatus = _.get(parent, 'status.status');
    return this.resolveCompliancePoliciesFromSpec(parent, aggregatedStatus);
  }

  static resolveCompliancePoliciesFromSpec(parent, aggregatedStatus) {
    const compliancePolicies = {};
    const policies = _.get(parent, 'spec.runtime-rules') ? _.get(parent, 'spec.runtime-rules') : [parent];
    policies.forEach((policy) => {
      const key = _.get(policy, 'metadata.name');
      const value = {
        name: _.get(policy, 'metadata.name'),
        complianceName: _.get(parent, 'metadata.name'),
        complianceNamespace: _.get(parent, 'metadata.namespace'),
        complianceSelfLink: _.get(parent, 'metadata.selfLink'),
        roleTemplates: this.resolvePolicyTemplates(policy, 'role-templates'),
        roleBindingTemplates: this.resolvePolicyTemplates(policy, 'roleBinding-templates'),
        objectTemplates: this.resolvePolicyTemplates(policy, 'object-templates'),
        policyTemplates: this.resolvePolicyTemplates(policy, 'policy-templates'),
        detail: this.resolvePolicyDetails(policy),
        raw: policy,
      };
      compliancePolicies[key] = value;
    });


    if (aggregatedStatus) {
      Object.values(aggregatedStatus).forEach((cluster) => {
        Object.entries(_.get(cluster, 'aggregatePoliciesStatus', {})).forEach(([key, value]) => {
          let policy;
          if (parent.spec['runtime-rules']) {
            policy = parent.spec['runtime-rules'].find(p => p.metadata.name === key);
          }
          const policyObject = {
            compliant: this.resolveStatus(value),
            enforcement: _.get(policy, 'spec.remediationAction', 'unknown'),
            message: _.get(value, 'message', '-'),
            rules: this.resolvePolicyRules(policy), // TODO: Use resolver.
            status: this.resolveStatus(value),
            violations: this.resolvePolicyViolations(policy, cluster), // TODO: Use resolver.
            metadata: {
              ...parent.metadata,
              name: key,
            },
          };

          compliancePolicies[key] = { ...compliancePolicies[key], ...policyObject };
        });
      });
    }

    return Object.values(compliancePolicies);
  }

  static resolvePolicyFromStatus(aggregatedStatus, parent) {
    const compliancePolicies = [];
    Object.values(aggregatedStatus).forEach((cluster) => {
      Object.entries(_.get(cluster, 'aggregatePoliciesStatus', {})).forEach(([key, value]) => {
        let policy;
        if (parent.spec['runtime-rules']) {
          policy = parent.spec['runtime-rules'].find(p => p.metadata.name === key);
        }
        const policyObject = {
          cluster: _.get(cluster, 'clustername', parent.metadata.namespace),
          complianceName: parent.metadata.name,
          complianceNamespace: parent.metadata.namespace,
          compliant: this.resolveStatus(value),
          enforcement: _.get(policy, 'spec.remediationAction', 'unknown'),
          message: _.get(value, 'message', '-'),
          name: key,
          rules: this.resolvePolicyRules(policy), // TODO: Use resolver.
          status: this.resolveStatus(value),
          valid: this.resolveValid(value),
          violations: this.resolvePolicyViolations(policy, cluster), // TODO: Use resolver.
          roleTemplates: this.resolvePolicyTemplates(policy, 'role-templates'),
          roleBindingTemplates: this.resolvePolicyTemplates(policy, 'roleBinding-templates'),
          objectTemplates: this.resolvePolicyTemplates(policy, 'object-templates'),
          detail: this.resolvePolicyDetails(policy),
          raw: policy,
          metadata: {
            ...parent.metadata,
            name: key,
          },
        };

        compliancePolicies.push(policyObject);
      });
    });

    const tempResult = {};
    Object.values(compliancePolicies).forEach((policy) => {
      if (!tempResult[policy.name]) {
        tempResult[policy.name] = {
          name: _.get(policy, 'name'),
          complianceName: _.get(policy, 'complianceName'),
          complianceNamespace: _.get(policy, 'complianceNamespace'),
          clusterCompliant: [],
          clusterNotCompliant: [],
          policies: [],
        };
      }
      tempResult[policy.name].policies.push(policy);
      if (_.get(policy, 'compliant', '').toLowerCase() === 'compliant') {
        tempResult[policy.name].clusterCompliant.push(_.get(policy, 'cluster'));
      } else {
        tempResult[policy.name].clusterNotCompliant.push(_.get(policy, 'cluster'));
      }
    });
    return Object.values(tempResult);
  }


  static resolvePolicyFromSpec(parent) {
    const compliancePolicies = [];
    const policies = _.get(parent, 'spec.runtime-rules', []);
    policies.forEach((policy) => {
      compliancePolicies.push({
        name: _.get(policy, 'metadata.name'),
        complianceName: _.get(parent, 'metadata.name'),
        complianceNamespace: _.get(parent, 'metadata.namespace'),
      });
    });
    return Object.values(compliancePolicies);
  }

  static resolveStatus(parent) {
    return _.get(parent, 'Compliant') || _.get(parent, 'compliant', 'unknown');
  }

  static resolveValid(parent) {
    if (_.get(parent, 'Valid') !== undefined) {
      return _.get(parent, 'Valid') ? true : 'invalid';
    }
    if (_.get(parent, 'valid') !== undefined) {
      return _.get(parent, 'valid') ? true : 'invalid';
    }
    return 'unknown';
  }

  static resolveComplianceStatus(parent) {
    const complianceStatus = [];
    Object.entries(_.get(parent, 'status.status', {})).forEach(([clusterName, perClusterStatus]) => {
      const aggregatedStatus = _.get(perClusterStatus, 'aggregatePoliciesStatus', {});

      // get compliant status per cluster
      if (aggregatedStatus) {
        let validNum = 0;
        let compliantNum = 0;
        let policyNum = 0;
        Object.values(aggregatedStatus).forEach((object) => {
          if (this.resolveStatus(object) === 'Compliant') compliantNum += 1;
          if (this.resolveValid(object)) validNum += 1;
          policyNum += 1;
        });
        complianceStatus.push({
          clusterNamespace: clusterName,
          localCompliantStatus: `${compliantNum}/${policyNum}`,
          localValidStatus: `${validNum}/${policyNum}`,
        });
      }
    });

    return complianceStatus;
  }


  static resolvePolicyCompliant({ status = {} }) {
    let totalPolicies = 0;
    let compliantPolicies = 0;

    Object.values(status.status || []).forEach((cluster) => {
      Object.values(cluster.aggregatePoliciesStatus || {}).forEach((policyValue) => {
        totalPolicies += 1;
        if (this.resolveStatus(policyValue).toLowerCase() === 'compliant') compliantPolicies += 1;
      });
    });

    return `${totalPolicies - compliantPolicies}/${totalPolicies}`;
  }


  static resolveClusterCompliant({ status = {} }) {
    if (status && status.status) {
      const totalClusters = Object.keys(status.status).length;
      const compliantClusters = Object.values(status.status || []).filter(cluster => (_.get(cluster, 'compliant', '').toLowerCase() === 'compliant'));
      return `${totalClusters - compliantClusters.length}/${totalClusters}`;
    }
    return '0/0';
  }

  static resolveAnnotations(parent) {
    const rawAnnotations = _.get(parent, 'metadata.annotations', {});
    const annotations = {};
    annotations.categories = _.get(rawAnnotations, 'policy.mcm.ibm.com/categories', '-');
    annotations.controls = _.get(rawAnnotations, 'policy.mcm.ibm.com/controls', '-');
    annotations.standards = _.get(rawAnnotations, 'policy.mcm.ibm.com/standards', '-');
    return annotations;
  }

  async getPlacementPolicies(parent = {}) {
    const policies = _.get(parent, 'status.placementPolicies', []);
    const response = await this.kubeConnector.getResources(
      ns => `/apis/mcm.ibm.com/v1alpha1/namespaces/${ns}/placementpolicies`,
      { kind: 'PlacementPolicy' },
    );
    const map = new Map();
    if (response) {
      response.forEach(item => map.set(item.metadata.name, item));
    }
    const placementPolicies = [];
    policies.forEach((policy) => {
      const pp = map.get(policy);
      if (pp) {
        const spec = pp.spec || {};
        placementPolicies.push({
          clusterLabels: spec.clusterLabels,
          metadata: pp.metadata,
          raw: pp,
          clusterReplicas: spec.clusterReplicas,
          resourceSelector: spec.resourceHint,
          status: pp.status,
        });
      }
    });
    return placementPolicies;
  }

  async getPlacementBindings(parent = {}) {
    const bindings = _.get(parent, 'status.placementBindings', []);
    const response = await this.kubeConnector.getResources(
      ns => `/apis/mcm.ibm.com/v1alpha1/namespaces/${ns}/placementbindings`,
      { kind: 'PlacementBinding' },
    );
    const map = new Map();
    if (response) {
      response.forEach(item => map.set(item.metadata.name, item));
    }
    const placementBindings = [];

    bindings.forEach((binding) => {
      const pb = map.get(binding);
      if (pb) {
        placementBindings.push({
          metadata: pb.metadata,
          raw: pb,
          placementRef: pb.placementRef,
          subjects: pb.subjects,
        });
      }
    });
    return placementBindings;
  }

  async getAllTemplates(policyName) {
    const allViolationsArray = [];
    if (policyName === null) {
      return allViolationsArray;
    }
    const response = await this.kubeConnector.resourceViewQuery('policies.policy.mcm.ibm.com');
    const clusterResults = _.get(response, 'status.results');
    const roleTemplates = [];
    const policyTemplates = [];
    _.forIn(clusterResults, (value) => {
      const paresdValues = _.get(value, 'items');
      paresdValues.forEach((policy) => {
        const roleTemplateResult = getTemplates(policy, 'role');
        const policyTemplateResult = getTemplates(policy, 'object');
        if (roleTemplateResult.length > 0) {
          roleTemplates.push(roleTemplateResult);
        } else if (policyTemplateResult.length > 0) {
          policyTemplates.push(policyTemplateResult);
        }
      });
    });
    let allTemplates = _.flattenDeep(roleTemplates);
    allTemplates = allTemplates.concat(_.flattenDeep(policyTemplates));

    return allTemplates;
  }

  async getPolicies(name, clusterName) {
    // if policy name specified
    if (name !== undefined) {
      // use kind when passing the apiGroup
      const response = await this.kubeConnector.resourceViewQuery('policies.policy.mcm.ibm.com', clusterName, name);
      const results = _.get(response, 'status.results');
      if (results) {
        const item = _.get(results, `${clusterName}`, {});
        if (item) {
          return [{ ...item, cluster: clusterName, raw: item }];
        }
      }
    }
    return [];
  }

  async getAllPoliciesInCluster(cluster) {
    // if policy name specified
    if (cluster !== undefined) {
      const response = await this.kubeConnector.resourceViewQuery('policies.policy.mcm.ibm.com', cluster, undefined, false, true);
      const results = _.get(response, 'status.results');
      if (results) {
        const item = _.get(results, `${cluster}`, {});
        if (item) {
          const result = [];
          item.items.forEach(policy => result.push({ ...policy, raw: policy }));
          return result;
        }
      }
    }
    return [];
  }

  async getAllClustersInPolicy(policyName) {
    // if policy name specified
    const response = await this.kubeConnector.resourceViewQuery('policies.policy.mcm.ibm.com');
    const results = _.get(response, 'status.results');
    const policiesMap = new Map();
    if (results) {
      let result = [];
      const clusterNames = Object.keys(results);
      for (const cluster of clusterNames) {
        const item = _.get(results, `${cluster}`, {});
        const policies = item.items;
        // eslint-disable-next-line
        policies.forEach((policy) => {
          if (_.get(policy, 'metadata.name') === policyName && _.get(policy, 'metadata.namespace') === cluster) {
            if (_.get(policy, 'status.compliant', '').toLowerCase() === 'compliant') {
              result.push({ name: cluster, status: 'compliant' });
            } else {
              result.push({ name: cluster, status: 'violated' });
            }
            policiesMap.set(cluster, policy);
          }
        });
      }
      const [clusters, clusterstatuses] = await Promise.all([
        this.kubeConnector.getResources(ns => `/apis/clusterregistry.k8s.io/v1alpha1/namespaces/${ns}/clusters`),
        this.kubeConnector.getResources(ns => `/apis/mcm.ibm.com/v1alpha1/namespaces/${ns}/clusterstatuses`),
      ]);
      const clusterMap = new Map();
      const clusterStatusMap = new Map();
      clusters.forEach(cluster => clusterMap.set(_.get(cluster, 'metadata.name', ''), cluster));
      clusterstatuses.forEach((cluster) => {
        clusterStatusMap.set(_.get(cluster, 'metadata.name', ''), { metadata: _.get(cluster, 'metadata'), spec: { consoleURL: _.get(cluster, 'spec.consoleURL') } });
      });
      result = createStatusResult(result);
      result = result.map((item) => {
        const { name } = item;
        const info = clusterMap.get(name);
        const status = clusterStatusMap.get(name);
        return {
          ...item, ...info, ...status, policy: policiesMap.get(name),
        };
      });
      return result;
    }
    return [];
  }

  async getAllViolationsInPolicy(policyName) {
    const resultsWithPolicyName = [];
    if (policyName === null) {
      return resultsWithPolicyName;
    }
    const response = await this.kubeConnector.resourceViewQuery('policies.policy.mcm.ibm.com');
    const clusterResults = _.get(response, 'status.results');
    _.forIn(clusterResults, (value, key) => {
      const paresdValues = _.get(value, 'items');
      paresdValues.forEach((val) => {
        if (val.metadata.name === policyName) {
          const resultInOneCluster = ComplianceModel.resolvePolicyViolations(val, key);
          if (resultInOneCluster[0].status === 'NonCompliant') {
            resultInOneCluster[0].cluster = key;
            resultsWithPolicyName.push(resultInOneCluster[0]);
          }
        }
      });
    });
    return resultsWithPolicyName;
  }


  static resolvePolicyDetails(parent) {
    return {
      exclude_namespace: _.get(parent, 'spec.namespaces.exclude', ['*']),
      include_namespace: _.get(parent, 'spec.namespaces.include', ['*']),
    };
  }

  static resolvePolicyEnforcement(parent) {
    return _.get(parent, 'spec.remediationAction', 'unknown');
  }

  static resolvePolicyRules(parent) {
    const rules = [];
    getTemplates(parent).forEach((res) => {
      if (res.rules) {
        Object.entries(res.rules).forEach(([key, rul]) => {
          const complianceType = _.get(rul, 'complianceType');
          if (complianceType) {
            const rule = {
              complianceType,
              apiGroups: _.get(rul, 'policyRule.apiGroups', ['-']),
              resources: _.get(rul, 'policyRule.resources', ['-']),
              verbs: _.get(rul, 'policyRule.verbs', ['-']),
              templateType: _.get(res, 'templateType', ''),
              ruleUID: `${_.get(res, 'metadata.name', '-')}-rule-${key}`,
            };
            rules.push(rule);
          }
        });
      }
    });
    return rules;
  }

  static resolveRoleSubjects(parent) {
    let roleSubjects = [];
    getTemplates(parent).forEach((res) => {
      if (_.get(res, 'templateType') === 'roleBinding-templates') {
        roleSubjects = [..._.get(res, 'roleBinding.subjects', [])];
      }
    });
    return roleSubjects;
  }

  static resolveRoleRef(parent) {
    const roleRef = [];
    getTemplates(parent).forEach((res) => {
      if (_.get(res, 'templateType') === 'roleBinding-templates') {
        roleRef.push(_.get(res, 'roleBinding.roleRef', {}));
      }
    });
    return roleRef;
  }

  static resolvePolicyStatus(parent) {
    if (_.get(parent, 'status.Compliant') || _.get(parent, 'status.compliant')) {
      return _.get(parent, 'status.Compliant') || _.get(parent, 'status.compliant');
    }
    if (_.get(parent, 'status.Valid') !== undefined) {
      return _.get(parent, 'status.Valid') ? 'valid' : 'invalid';
    }
    if (_.get(parent, 'status.valid') !== undefined) {
      return _.get(parent, 'status.valid') ? 'valid' : 'invalid';
    }
    return 'unknown';
  }

  static resolvePolicyMessage(parent) {
    return _.get(parent, 'status.message', '-');
  }

  static resolvePolicyTemplates(parent, type) {
    const tempArray = [];
    getTemplates(parent).forEach((res) => {
      if (_.get(res, 'templateType') === type) {
        if (type === 'roleBinding-templates') {
          tempArray.push({
            name: _.get(res, 'roleBinding.metadata.name', '-'),
            lastTransition: _.get(res, 'status.conditions[0].lastTransitionTime', ''),
            complianceType: _.get(res, 'complianceType', ''),
            apiVersion: _.get(res, 'roleBinding.apiVersion', ''),
            compliant: _.get(res, 'status.Compliant', ''),
            validity: _.get(res, 'status.Validity.valid') || _.get(res, 'status.Validity', ''),
            raw: res,
          });
        } else if (type === 'object-templates' || type === 'policy-templates') {
          tempArray.push({
            name: _.get(res, 'objectDefinition.metadata.name', '-'),
            lastTransition: _.get(res, 'status.conditions[0].lastTransitionTime', ''),
            complianceType: _.get(res, 'complianceType', ''),
            apiVersion: _.get(res, 'objectDefinition.apiVersion', ''),
            kind: _.get(res, 'objectDefinition.kind', ''),
            compliant: _.get(res, 'status.Compliant', ''),
            status: _.get(res, 'status.Compliant', ''),
            validity: _.get(res, 'status.Validity.valid') || _.get(res, 'status.Validity', ''),
            raw: res,
          });
        } else {
          tempArray.push({
            name: _.get(res, 'metadata.name', '-'),
            lastTransition: _.get(res, 'status.conditions[0].lastTransitionTime', ''),
            complianceType: _.get(res, 'complianceType', ''),
            apiVersion: _.get(res, 'apiVersion', ''),
            compliant: _.get(res, 'status.Compliant', ''),
            status: _.get(res, 'status.Compliant', ''),
            validity: _.get(res, 'status.Validity.valid') || _.get(res, 'status.Validity', ''),
            raw: res,
          });
        }
      }
    });
    return tempArray;
  }

  static resolvePolicyViolations(parent, cluster) {
    const violationArray = [];
    getTemplates(parent).forEach((res) => {
      const templateCondition = _.get(res, 'status.conditions[0]');
      if (_.get(res, 'templateType') === 'role-templates') {
        violationArray.push({
          name: _.get(res, 'metadata.name', '-'),
          cluster: _.get(cluster, 'clustername', '-'),
          status: this.resolvePolicyStatus(res),
          message: (templateCondition && _.get(templateCondition, 'message', '-')) || '-',
          reason: (templateCondition && _.get(templateCondition, 'reason', '-')) || '-',
          selector: _.get(res, 'selector', ''),
        });
      } else if (_.get(res, 'templateType') === 'object-templates' || _.get(res, 'templateType') === 'policy-templates') {
        violationArray.push({
          name: _.get(res, 'objectDefinition.metadata.name', '-'),
          cluster: _.get(cluster, 'clustername', '-'),
          status: this.resolvePolicyStatus(res),
          message: (templateCondition && _.get(templateCondition, 'message', '-')) || '-',
          reason: (templateCondition && _.get(templateCondition, 'reason', '-')) || '-',
          selector: _.get(res, 'selector', ''),
        });
      }
    });
    return violationArray;
  }
}
