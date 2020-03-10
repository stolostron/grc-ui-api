/** *****************************************************************************
 * Licensed Materials - Property of IBM
 * (c) Copyright IBM Corporation 2018, 2020. All Rights Reserved.
 * Copyright (c) 2020 Red Hat, Inc.
 *
 * Note to U.S. Government Users Restricted Rights:
 * Use, duplication or disclosure restricted by GSA ADP Schedule
 * Contract with IBM Corp.
 ****************************************************************************** */

export const typeDef = `
# MCM Placement
type Placement implements K8sObject {
  metadata: Metadata
  placementBindings: [PlacementBinding]
  placementPolicies: [PlacementPolicy]
  # The object's yaml definition in JSON format.
  raw: JSON
  selector: JSON
}

type PlacementPolicy implements K8sObject {
  clusterLabels: JSON
  metadata: Metadata
  # The object's yaml definition in JSON format.
  raw: JSON
  clusterReplicas: Int
  resourceSelector: JSON
  status: JSON
}

type PlacementBinding implements K8sObject {
  metadata: Metadata
  # The object's yaml definition in JSON format.
  raw: JSON
  placementRef: Subject
  subjects: [Subject]
}

type Subject {
  apiGroup: String
  kind: String
  name: String
}
`;

export const resolver = {
  Query: {
    placementPolicies: (root, args, { PlacementModel }) =>
      PlacementModel.getPlacementPolicies(args.selector),
  },
  Placement: {
    placementBindings: (parent, args, { PlacementModel }) =>
      PlacementModel.getPlacementBindings({ matchNames: parent.placementBindingNames }),
    placementPolicies: (parent, args, { PlacementModel }) =>
      PlacementModel.getPlacementPolicies({ matchNames: parent.placementPolicyNames }),
  },
};
