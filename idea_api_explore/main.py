## Link with baseUrl
import sys
import ideastatica_connection_api.connection_api_service_attacher as connection_api_service_attacher

def main():
    ## Configure logging
    baseUrl = "http://localhost:5000"

    ## Absolute path into folder with your python script and connection module
    if len(sys.argv) < 2:
        print("Please provide a path to an .ideaCon file.")
        sys.exit(1)
        
    project_file_path = sys.argv[1]
    print(f"Opening project: {project_file_path}")

    with connection_api_service_attacher.ConnectionApiServiceAttacher(baseUrl).create_api_client() as api_client:
        try:
            ## Open the project
            openProject = api_client.project.open_project_from_filepath(project_file_path)

            ## Unique project ID that provide the control over the model
            projectId = api_client.project.active_project_id
            print(f"Project ID: {projectId}")

            if not openProject.connections:
                print("No connections found in the project.")
                return

            ## Opening project that will be calculated
            connection = openProject.connections[0]
            print(f"Connection: {connection}")

            connection_ID = [connection.id]
            ## Assigning connection ID
            calculation_run = api_client.calculation.calculate(
                projectId,
                connection_ID
            )
            print('Finished')

            ## Postprocessing - extract the unity check of connection
            Results = calculation_run[0].result_summary
            ## Loop over all unity checks like plates, bolts, welds
            for results in Results:
                print(results.unity_check_message)

        except Exception as e:
            print("Operation failed : %s\n" % e)

if __name__ == '__main__':
    main()
