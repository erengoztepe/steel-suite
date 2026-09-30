import sys
import json
import argparse

try:
    from ideastatica_connection_api.connection_api_service_attacher import ConnectionApiServiceAttacher
    from ideastatica_connection_api import IdeaParameterUpdate
except ImportError:
    print(json.dumps({"error": "Missing SDK. Please run: pip install ideastatica-connection-api==26.0.*"}))
    sys.exit(1)


def parse_cost(cost_obj):
    if cost_obj is None:
        return None

    data = cost_obj.to_dict() if hasattr(cost_obj, 'to_dict') else vars(cost_obj)
    clean_data = {k.lstrip('_'): v for k, v in data.items()}

    for keyword in ["total", "cost", "price"]:
        for k, v in clean_data.items():
            if keyword in k.lower() and isinstance(v, (int, float)):
                return v
    
    numeric_sum = sum(v for v in clean_data.values() if isinstance(v, (int, float)))
    if numeric_sum > 0:
        return numeric_sum
        
    return 0.0


def parse_check_status(result_summary):
    if not result_summary:
        return False, None
    
    all_passed = True
    max_util = 0.0
    valid_checks = 0

    for check in result_summary:
        if getattr(check, 'skipped', False):
            continue
        
        valid_checks += 1
        
        status = getattr(check, 'check_status', False)
        if isinstance(status, str):
            status = status.lower() in ["ok", "pass", "passed", "true"]
        
        if not status:
            all_passed = False
        
        val = getattr(check, 'check_value', 0.0)
        if val is not None and val > max_util:
            max_util = val

    if valid_checks == 0:
        return False, None
        
    return all_passed, max_util


def run_sweep(base_url, project_id, conn_id, parameter_key, range_list, sweep_direction):
    history = []
    
    try:
        attacher = ConnectionApiServiceAttacher(base_url)
    except Exception as e:
        print(f"ConnectionError: {e}", file=sys.stderr)
        return {"error": f"Could not connect to API at {base_url}. Error: {e}"}

    try:
        with attacher.create_api_client() as api_client:
            # We don't open from file. We assume project_id is already loaded in the REST API.
            # But the attacher might need us to explicitly set active project id if the API supports it.
            # Usually, if we just pass project_id and conn_id to the methods, it works.
            
            # 1. Check if parameters exist
            params = api_client.parameter.get_parameters(project_id, conn_id)
            param_keys = [p.key for p in params] if params else []
            
            if parameter_key not in param_keys:
                return {"error": f"Parameter '{parameter_key}' not found in connection. Available parameters are: {param_keys}"}

            best_passing_val = None
            best_cost = float('inf')

            for iteration, val in enumerate(range_list, 1):
                print(f"[Iter {iteration}] Testing {parameter_key} = {val}...", file=sys.stderr)
                
                # 1. Update Parameter
                expression_val = "true" if val is True else ("false" if val is False else str(val))
                update_req = IdeaParameterUpdate(key=parameter_key, expression=expression_val)
                api_client.parameter.update(project_id, conn_id, [update_req])
                
                # 2. Calculate
                calc_results = api_client.calculation.calculate(project_id, [conn_id])
                if not calc_results or not calc_results[0].result_summary:
                    status = False
                    max_util = None
                else:
                    status, max_util = parse_check_status(calc_results[0].result_summary)
                
                # 3. Get Cost
                cost_obj = api_client.connection.get_production_cost(project_id, conn_id)
                cost = parse_cost(cost_obj)
                
                history.append({
                    "iteration": iteration,
                    "value": val,
                    "status": "PASS" if status else "FAIL",
                    "max_utilization": max_util,
                    "cost": cost
                })
                
                print(f"  -> Result: {'PASS' if status else 'FAIL'} | Max Util: {max_util}% | Cost: {cost}", file=sys.stderr)

                # 4. Sweep Boundary Logic
                if status:
                    if cost is not None and cost < best_cost:
                        best_cost = cost
                        best_passing_val = val
                    elif best_passing_val is None:
                        best_passing_val = val

                if sweep_direction == 'DECREASING':
                    if not status:
                        break
                elif sweep_direction == 'INCREASING':
                    if status:
                        break
                        
            # Apply best passing value before exiting
            if best_passing_val is not None:
                print(f"Applying best passing value: {best_passing_val}", file=sys.stderr)
                expr = "true" if best_passing_val is True else ("false" if best_passing_val is False else str(best_passing_val))
                api_client.parameter.update(project_id, conn_id, [IdeaParameterUpdate(key=parameter_key, expression=expr)])
                api_client.calculation.calculate(project_id, [conn_id])

            return {"history": history, "best_value": best_passing_val}

    except Exception as e:
        print(f"SweepError: {e}", file=sys.stderr)
        return {"error": f"API Error during sweep: {e}"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IDEA StatiCa Optimizer CLI")
    parser.add_argument("--base-url", type=str, default="http://localhost:5000", help="API Base URL")
    parser.add_argument("--project-id", type=str, required=True, help="Active Project GUID")
    parser.add_argument("--conn-id", type=int, required=True, help="Connection ID")
    parser.add_argument("--parameter", type=str, required=True, help="Parameter Key to sweep")
    parser.add_argument("--direction", type=str, choices=['INCREASING', 'DECREASING', 'UNORDERED'], default='DECREASING', help="Sweep direction logic")
    parser.add_argument("--range", type=str, required=True, help="Comma separated list of values to test")

    args = parser.parse_args()

    # Parse range string to float list
    try:
        range_values = [float(x.strip()) for x in args.range.split(",")]
    except ValueError:
        print(json.dumps({"error": "Invalid range format. Must be comma-separated numbers."}))
        sys.exit(1)

    result = run_sweep(
        base_url=args.base_url,
        project_id=args.project_id,
        conn_id=args.conn_id,
        parameter_key=args.parameter,
        range_list=range_values,
        sweep_direction=args.direction
    )

    # Output ONLY JSON to stdout
    print(json.dumps(result))
