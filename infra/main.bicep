// AvailCal infrastructure — Model B: a scheduled, scale-to-zero Container Apps
// Job (NOT an always-on service) that runs the merge pipeline hourly.
//
// Provisions: Storage Account + blob container, Key Vault (RBAC mode),
// Log Analytics + Container Apps managed environment, and the Microsoft.App/jobs
// resource with a cron Schedule trigger. The job's system-assigned identity gets
// least-privilege RBAC: Key Vault Secrets User + Storage Blob Data Contributor.

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short name prefix for resources (3-11 lowercase alphanumerics).')
@minLength(3)
@maxLength(11)
param namePrefix string = 'availcal'

@description('Container image for the merge job, e.g. myregistry.azurecr.io/availcal:latest')
param containerImage string

@description('Cron expression for the job schedule (UTC). Default: hourly.')
param cronExpression string = '0 * * * *'

@description('Blob container name that holds /raw and /merged outputs.')
param blobContainerName string = 'availcal'

@description('Default timezone for all-day/floating events lacking a TZID.')
param defaultTz string = 'America/New_York'

@description('Expansion horizon in days.')
param horizonDays int = 90

@description('Treat tentative events as busy.')
param includeTentative bool = true

// Optional ACR for managed-identity image pulls. Empty => image assumed public
// or otherwise reachable; no registry credential block is emitted.
@description('ACR login server for managed-identity pulls (optional).')
param acrLoginServer string = ''

var storageAccountName = toLower('${namePrefix}${uniqueString(resourceGroup().id)}')
var keyVaultName = toLower('${namePrefix}kv${uniqueString(resourceGroup().id)}')
var logAnalyticsName = '${namePrefix}-logs'
var environmentName = '${namePrefix}-env'
var jobName = '${namePrefix}-merge'

// Built-in role definition IDs.
var roleStorageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var roleKeyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

// ---------------------------------------------------------------------------
// Storage: account + single private blob container.
// ---------------------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false // feed is private; clients use a secret blob URL/SAS
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: blobContainerName
  properties: {
    publicAccess: 'None'
  }
}

// ---------------------------------------------------------------------------
// Key Vault (RBAC authorization) — holds secret feed URLs / CalDAV passwords.
// ---------------------------------------------------------------------------
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

// ---------------------------------------------------------------------------
// Log Analytics + Container Apps managed environment.
// ---------------------------------------------------------------------------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The scheduled merge job (scale-to-zero: it only runs on the cron trigger).
// ---------------------------------------------------------------------------
resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      // Managed-identity pull from ACR when an ACR server is supplied.
      registries: empty(acrLoginServer) ? [] : [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'merge'
          image: containerImage
          // The image defaults to the HTTP server (for Cloudflare Containers);
          // an ACA Job is one-shot, so override to the CLI which runs a single
          // pull->merge->emit->upload cycle and exits.
          command: [
            'availcal'
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'AVAILCAL_STORAGE_ACCOUNT'
              value: storage.name
            }
            {
              name: 'AVAILCAL_BLOB_CONTAINER'
              value: blobContainerName
            }
            {
              name: 'AVAILCAL_KEYVAULT_URI'
              value: keyVault.properties.vaultUri
            }
            {
              name: 'AVAILCAL_DEFAULT_TZ'
              value: defaultTz
            }
            {
              name: 'AVAILCAL_HORIZON_DAYS'
              value: string(horizonDays)
            }
            {
              name: 'AVAILCAL_INCLUDE_TENTATIVE'
              value: string(includeTentative)
            }
          ]
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// RBAC: grant the job's identity least-privilege access.
// ---------------------------------------------------------------------------
resource storageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, job.id, roleStorageBlobDataContributor)
  scope: storage
  properties: {
    principalId: job.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleStorageBlobDataContributor
    )
    principalType: 'ServicePrincipal'
  }
}

resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, job.id, roleKeyVaultSecretsUser)
  scope: keyVault
  properties: {
    principalId: job.identity.principalId
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleKeyVaultSecretsUser
    )
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = storage.name
output blobContainerName string = blobContainerName
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output jobName string = job.name
output jobPrincipalId string = job.identity.principalId
@description('Merged feed blob path (subscribe clients to a SAS/secret URL of this).')
output mergedFeedBlobPath string = '${blobContainerName}/merged/availability.ics'
